const MODEL = "@cf/google/gemma-4-26b-a4b-it";

// Shopper's Suggestions AI Manager
// Full Worker replacement.
// Includes AI chat, research, drafts, manager runs, duplicate checks,
// scheduled runs, dashboard, GitHub test and Manager UI.

const CHAT_SESSION_ID = "main";
const MAX_HISTORY = 30;
const CHAT_RETENTION_HOURS = 24;

const CATEGORIES = [
  "Tech","Home","Fashion","Beauty","Gaming","Sports","Travel","Kitchen",
  "Office","Automotive","Electronics","Kids","Pets","Fitness","Books",
  "Accessories","Photography","Creator","Other"
];

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (method === "OPTIONS")
        return new Response(null, { headers: corsHeaders() });

      await ensureTables(env);

      if (path === "/" && method === "GET")
        return new Response(managerPage(), {
          headers: {"content-type":"text/html;charset=UTF-8"}
        });

      if (path === "/api/health" && method === "GET")
        return json({
          ok:true,
          manager:"shopper-ai-manager",
          ai:!!env.AI,
          database:!!env.DB,
          assets:!!env.ASSETS,
          model:MODEL
        });

      if (path === "/api/dashboard" && method === "GET")
        return dashboard(env);

      if (path === "/api/products" && method === "GET")
        return getProducts(env);

      const productMatch = path.match(/^\/api\/products\/(\d+)$/);
      if (productMatch && method === "GET")
        return getProduct(env, Number(productMatch[1]));

      if (path === "/api/ai/chat" && method === "POST")
        return aiChat(request,env);

      if (path === "/api/ai/chat/reset" && method === "POST")
        return resetChat(env);

      if (path === "/api/research" && method === "POST")
        return research(request,env);

      if (path === "/api/products/classify" && method === "POST")
        return classifyProduct(request,env);

      if (path === "/api/products/improve" && method === "POST")
        return improveProduct(request,env);

      if (path === "/api/marketing" && method === "POST")
        return marketing(request,env);

      if (path === "/api/drafts" && method === "GET")
        return getDrafts(env);

      if (path === "/api/drafts" && method === "POST")
        return createDraft(request,env);

      const publishMatch = path.match(/^\/api\/drafts\/(\d+)\/publish$/);
      if (publishMatch && method === "POST")
        return publishDraft(env,Number(publishMatch[1]));

      if (path === "/api/tasks" && method === "GET")
        return getTasks(env);

      if (path === "/api/tasks" && method === "POST")
        return createTask(request,env);

      if (path === "/api/logs" && method === "GET")
        return getLogs(env);

      if (path === "/api/manager/run" && method === "POST")
        return runManager(request,env,ctx);

      if (path === "/api/manager/step" && method === "POST")
        return managerStep(request,env);

      if (path === "/api/manager/status" && method === "GET")
        return managerStatus(env);

      if (path === "/api/integrations" && method === "GET")
        return integrations(env);

      if (path === "/api/integrations/github/test" && method === "GET")
        return testGitHub(env);

      if (path === "/api/integrations/instagram/test" && method === "GET")
        return json({
          ok:false,connected:false,service:"instagram",
          message:"Instagram publishing requires an authorized Meta/Instagram integration."
        });

      if (path === "/api/integrations/affiliate/test" && method === "GET")
        return json({
          ok:false,connected:false,service:"affiliate",
          message:"Affiliate publishing requires an authorized affiliate-platform integration."
        });

      if (path === "/api/categories" && method === "GET")
        return json({ok:true,categories:CATEGORIES});

      return json({ok:false,error:"Route not found"},404);

    } catch(error) {
      console.error(error);

      return json({
        ok:false,
        error:error?.message || String(error)
      },500);
    }
  },

  async scheduled(event,env,ctx) {
    ctx.waitUntil(runScheduledManager(env));
  }
};

function corsHeaders() {
  return {
    "access-control-allow-origin":"*",
    "access-control-allow-methods":"GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":"Content-Type, Authorization",
    "content-type":"application/json;charset=UTF-8"
  };
}

function json(data,status=200) {
  return new Response(JSON.stringify(data,null,2),{
    status,
    headers:corsHeaders()
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function safeString(value,fallback="") {
  if(value===null || value===undefined)
    return fallback;

  return String(value).trim();
}

function nowISO() {
  return new Date().toISOString();
}

async function ensureTables(env) {
  if(!env.DB)
    throw new Error("D1 database binding DB is missing.");

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS manager_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        affiliate_url TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'Other',
        image_urls TEXT NOT NULL DEFAULT '[]',
        video_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS manager_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        data_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS manager_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS manager_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'running',
        stage TEXT NOT NULL DEFAULT 'starting',
        message TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS manager_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `)
  ]);
}

async function cleanExpiredChat(env) {
  await env.DB.prepare(`
    DELETE FROM manager_chat_messages
    WHERE expires_at <= datetime('now')
  `).run();
}

async function aiChat(request,env) {
  if(!env.AI)
    return json({
      ok:false,
      error:"Workers AI binding AI is missing."
    },500);

  const body=await readJson(request);

  const message=safeString(
    body.message ||
    body.prompt ||
    body.content
  );

  if(!message)
    return json({
      ok:false,
      error:"Message is required."
    },400);

  await cleanExpiredChat(env);

  const historyResult=await env.DB.prepare(`
    SELECT role,content
    FROM manager_chat_messages
    WHERE session_id=?
      AND expires_at>datetime('now')
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    CHAT_SESSION_ID,
    MAX_HISTORY
  ).all();

  const history=(historyResult.results||[])
    .reverse()
    .map(row=>({
      role:row.role,
      content:row.content
    }));

  await env.DB.prepare(`
    INSERT INTO manager_chat_messages
    (session_id,role,content,created_at,expires_at)
    VALUES(
      ?,?,
      ?,
      datetime('now'),
      datetime('now','+24 hours')
    )
  `).bind(
    CHAT_SESSION_ID,
    "user",
    message
  ).run();

  const systemPrompt=`
You are the AI Manager for Shopper's Suggestions.

Website:
https://shopperssuggestions.online

Help with product opportunities, research, titles, descriptions,
categories, affiliate ideas, marketing, Instagram content,
listing improvements, trend analysis, campaigns and workflow planning.

Do not invent affiliate links.
Do not claim external services are connected when they are not.
Do not claim an action happened unless the system performed it.
Clearly distinguish research from verified facts.
`;

  let answer="";

  try {
    const result=await env.AI.run(MODEL,{
      messages:[
        {
          role:"system",
          content:systemPrompt
        },

        ...history,

        {
          role:"user",
          content:message
        }
      ],

      max_tokens:1200,
      temperature:.7
    });

    answer=
      result?.response ||
      result?.text ||
      result?.output_text ||
      result?.choices?.[0]?.message?.content ||
      JSON.stringify(result);

  } catch(error) {
    return json({
      ok:false,
      error:"AI request failed.",
      details:error?.message || String(error)
    },500);
  }

  await env.DB.prepare(`
    INSERT INTO manager_chat_messages
    (session_id,role,content,created_at,expires_at)
    VALUES(
      ?,?,
      ?,
      datetime('now'),
      datetime('now','+24 hours')
    )
  `).bind(
    CHAT_SESSION_ID,
    "assistant",
    answer
  ).run();

  await addLog(
    env,
    "info",
    "AI chat completed",
    {
      session_id:CHAT_SESSION_ID
    }
  );

  return json({
    ok:true,
    answer,
    model:MODEL,
    session_id:CHAT_SESSION_ID,
    retention_hours:CHAT_RETENTION_HOURS
  });
}

async function resetChat(env) {
  await env.DB.prepare(`
    DELETE FROM manager_chat_messages
    WHERE session_id=?
  `).bind(
    CHAT_SESSION_ID
  ).run();

  await addLog(
    env,
    "info",
    "AI chat reset",
    {}
  );

  return json({
    ok:true,
    reset:true
  });
}

async function dashboard(env) {
  const [
    products,
    published,
    drafts,
    tasks,
    logs,
    run
  ]=await Promise.all([

    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM products
    `).first(),

    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM products
      WHERE published=1
    `).first(),

    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM manager_drafts
      WHERE status='draft'
    `).first(),

    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM manager_tasks
      WHERE status IN ('pending','running')
    `).first(),

    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM manager_logs
    `).first(),

    env.DB.prepare(`
      SELECT *
      FROM manager_runs
      ORDER BY started_at DESC
      LIMIT 1
    `).first()

  ]);

  return json({
    ok:true,

    products:Number(
      products?.count||0
    ),

    published_products:Number(
      published?.count||0
    ),

    drafts:Number(
      drafts?.count||0
    ),

    active_tasks:Number(
      tasks?.count||0
    ),

    logs:Number(
      logs?.count||0
    ),

    latest_run:run||null,

    ai:!!env.AI,
    database:!!env.DB
  });
}

async function getProducts(env) {
  const result=await env.DB.prepare(`
    SELECT *
    FROM products
    WHERE published=1
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  return json({
    ok:true,
    products:result.results||[]
  });
}

async function getProduct(env,id) {
  const product=await env.DB.prepare(`
    SELECT *
    FROM products
    WHERE id=?
    LIMIT 1
  `).bind(id).first();

  if(!product)
    return json({
      ok:false,
      error:"Product not found."
    },404);

  return json({
    ok:true,
    product
  });
}

async function research(request,env) {
  const body=await readJson(request);

  const query=safeString(
    body.query ||
    body.product ||
    body.topic
  );

  if(!query)
    return json({
      ok:false,
      error:"Research query is required."
    },400);

  const answer=await runAI(env,`
Research and analyze this affiliate-product opportunity:

${query}

Return:
1. Product opportunity
2. Target customer
3. Problem it solves
4. Why people may search for it
5. Buying considerations
6. Possible content angles
7. Suggested category
8. Risks or things that need verification

Do not invent exact sales numbers, prices, ratings, or trends.
`);

  await addLog(
    env,
    "info",
    "Product research completed",
    {query}
  );

  return json({
    ok:true,
    query,
    result:answer
  });
}

async function classifyProduct(request,env) {
  const body=await readJson(request);

  const title=safeString(body.title);
  const description=safeString(body.description);

  if(!title&&!description)
    return json({
      ok:false,
      error:"Product title or description is required."
    },400);

  const answer=await runAI(env,`
Classify this product for Shopper's Suggestions.

Title:
${title}

Description:
${description}

Available categories:
${CATEGORIES.join(", ")}

Return JSON only:
{"category":"...","reason":"...","keywords":["...","...","..."]}
`);

  return json({
    ok:true,
    result:answer
  });
}

async function improveProduct(request,env) {
  const body=await readJson(request);

  const answer=await runAI(env,`
Improve this affiliate product listing.

Title:
${safeString(body.title)}

Description:
${safeString(body.description)}

Category:
${safeString(body.category)}

Create:
1. Better title
2. Clear product description
3. Short selling points
4. Call-to-action
5. Search keywords

Do not invent technical specifications that were not supplied.
`);

  return json({
    ok:true,
    result:answer
  });
}

async function marketing(request,env) {
  const body=await readJson(request);

  const title=safeString(body.title);
  const description=safeString(body.description);
  const platform=safeString(
    body.platform,
    "Instagram"
  );

  if(!title&&!description)
    return json({
      ok:false,
      error:"Product information is required."
    },400);

  const answer=await runAI(env,`
Create marketing content for this affiliate product.

Product:
${title}

Description:
${description}

Platform:
${platform}

Create:
- Hook
- Short promotional caption
- 5 relevant hashtags
- Short video/Reel concept
- CTA

Do not make unsupported claims.
`);

  await addLog(
    env,
    "info",
    "Marketing content generated",
    {
      product:title,
      platform
    }
  );

  return json({
    ok:true,
    result:answer
  });
}

async function getDrafts(env) {
  const result=await env.DB.prepare(`
    SELECT *
    FROM manager_drafts
    ORDER BY id DESC
    LIMIT 100
  `).all();

  return json({
    ok:true,
    drafts:result.results||[]
  });
}

async function createDraft(request,env) {
  const body=await readJson(request);

  return insertManagerDraft(env,{
    title:safeString(body.title),

    description:safeString(
      body.description
    ),

    affiliate_url:safeString(
      body.affiliate_url ||
      body.affiliateUrl
    ),

    category:safeString(
      body.category,
      "Other"
    ),

    image_urls:Array.isArray(body.image_urls)
      ? body.image_urls
      : Array.isArray(body.images)
        ? body.images
        : [],

    video_url:safeString(
      body.video_url ||
      body.videoUrl
    ),

    source:"manual"
  });
}

async function insertManagerDraft(env,data) {
  const now=nowISO();

  const result=await env.DB.prepare(`
    INSERT INTO manager_drafts
    (
      title,
      description,
      affiliate_url,
      category,
      image_urls,
      video_url,
      status,
      created_at,
      updated_at
    )
    VALUES(
      ?,?,?,?,?,?,
      'draft',
      ?,?
    )
  `).bind(

    safeString(data.title),

    safeString(data.description),

    safeString(data.affiliate_url),

    safeString(data.category,"Other"),

    JSON.stringify(
      Array.isArray(data.image_urls)
        ? data.image_urls
        : []
    ),

    safeString(data.video_url),

    now,
    now

  ).run();

  await addLog(
    env,
    "info",
    "Draft created",
    {
      draft_id:result.meta?.last_row_id,
      source:data.source||"unknown"
    }
  );

  return json({
    ok:true,
    draft_id:result.meta?.last_row_id||null
  });
}
    AND lower(title) LIKE ?
    LIMIT 10
  `).bind(`%${words.slice(0,3).join("%")}%`).all();

  return (drafts.results||[]).length > 0;
}

async function createManagerDraft(env,research,runId) {
  const now=nowISO();

  const verificationNotes=Array.isArray(research.verification_notes)
    ? research.verification_notes
    : [];

  const sellingPoints=Array.isArray(research.selling_points)
    ? research.selling_points
    : [];

  const descriptionParts=[];

  if(research.description)
    descriptionParts.push(research.description);

  if(research.target_customer)
    descriptionParts.push(
      `Target customer: ${research.target_customer}`
    );

  if(research.problem_solved)
    descriptionParts.push(
      `Problem addressed: ${research.problem_solved}`
    );

  if(sellingPoints.length)
    descriptionParts.push(
      `Selling points:\n${sellingPoints.map(x=>`• ${x}`).join("\n")}`
    );

  if(verificationNotes.length)
    descriptionParts.push(
      `Verification needed before publishing:\n${verificationNotes.map(x=>`• ${x}`).join("\n")}`
    );

  const result=await env.DB.prepare(`
    INSERT INTO manager_drafts
    (
      title,
      description,
      affiliate_url,
      category,
      image_urls,
      video_url,
      status,
      created_at,
      updated_at
    )
    VALUES(
      ?,?,
      '',
      ?,
      '[]',
      '',
      'draft',
      ?,?
    )
  `).bind(
    safeString(research.title),
    descriptionParts.join("\n\n"),
    normalizeCategory(research.category),
    now,
    now
  ).run();

  const draftId=result.meta?.last_row_id||null;

  await addLog(
    env,
    "info",
    "Manager draft created",
    {
      run_id:runId,
      draft_id:draftId,
      title:research.title
    }
  );

  return {
    id:draftId,
    title:research.title,
    category:normalizeCategory(research.category),
    status:"draft"
  };
}

/* =========================================================
   NEW BOUNDED MANAGER ENGINE

   The old engine used one long ctx.waitUntil() chain.
   This version performs ONE bounded operation per /step request.
   That prevents long Manager runs from getting stuck.
========================================================= */

async function runManager(request,env,ctx) {
  if(!env.AI)
    return json({
      ok:false,
      error:"Workers AI binding AI is missing."
    },500);

  // Stop genuinely stale runs.
  await env.DB.prepare(`
    UPDATE manager_runs
    SET
      status='failed',
      stage='failed',
      message='Automatically stopped: stale Manager run.',
      finished_at=?,
      updated_at=?
    WHERE status='running'
      AND updated_at < datetime('now','-15 minutes')
  `).bind(
    nowISO(),
    nowISO()
  ).run();

  // Prevent two active Manager runs.
  const active=await env.DB.prepare(`
    SELECT id
    FROM manager_runs
    WHERE status='running'
    ORDER BY started_at DESC
    LIMIT 1
  `).first();

  if(active)
    return json({
      ok:false,
      error:"A Manager run is already active.",
      run_id:active.id
    },409);

  const body=await readJson(request);

  const focus=safeString(
    body.focus ||
    body.query ||
    body.topic,

    "Find useful product opportunities for Shopper's Suggestions."
  );

  const runId=createRunId();
  const now=nowISO();

  const state={
    focus,
    opportunities:[],
    current_index:0,
    drafts:[],
    rejected:[],
    discovery_done:false
  };

  await env.DB.prepare(`
    INSERT INTO manager_runs
    (
      id,
      status,
      stage,
      message,
      result_json,
      started_at,
      updated_at
    )
    VALUES(
      ?,
      'running',
      'discovering',
      'Starting Manager...',
      ?,
      ?,
      ?
    )
  `).bind(
    runId,
    JSON.stringify(state),
    now,
    now
  ).run();

  await addLog(
    env,
    "info",
    "Manager run created",
    {
      run_id:runId,
      focus
    }
  );

  /*
    IMPORTANT:

    We intentionally DO NOT use:

      ctx.waitUntil(executeManagerRun(...))

    here.

    The browser will call /api/manager/step repeatedly.
  */

  return json({
    ok:true,
    started:true,
    run_id:runId,
    message:"Manager started."
  });
}

async function managerStep(request,env) {
  if(!env.AI)
    return json({
      ok:false,
      error:"Workers AI binding AI is missing."
    },500);

  const body=await readJson(request);

  const requestedRunId=safeString(
    body.run_id ||
    body.runId
  );

  let run=null;

  if(requestedRunId) {
    run=await env.DB.prepare(`
      SELECT *
      FROM manager_runs
      WHERE id=?
      LIMIT 1
    `).bind(
      requestedRunId
    ).first();
  } else {
    run=await env.DB.prepare(`
      SELECT *
      FROM manager_runs
      WHERE status='running'
      ORDER BY started_at DESC
      LIMIT 1
    `).first();
  }

  if(!run)
    return json({
      ok:false,
      error:"No active Manager run found."
    },404);

  if(run.status!=="running") {
    return json({
      ok:true,
      done:true,
      run
    });
  }

  /*
    Recover runs that were left running for too long.
  */
  const age=Date.now()-new Date(
    run.updated_at
  ).getTime();

  if(Number.isFinite(age) && age>15*60*1000) {
    await finishManagerRun(
      env,
      run.id,
      "failed",
      "Manager run timed out and was safely stopped.",
      {}
    );

    const stopped=await getManagerRun(
      env,
      run.id
    );

    return json({
      ok:true,
      done:true,
      run:stopped
    });
  }

  let state={};

  try {
    state=JSON.parse(
      run.result_json||"{}"
    );
  } catch {
    state={};
  }

  /*
    STEP 1:
    Discover opportunities.

    Only ONE AI call happens in this request.
  */
  if(run.stage==="discovering") {
    try {
      await updateManagerRun(
        env,
        run.id,
        "discovering",
        "Finding product opportunities..."
      );

      const opportunities=
        await discoverProductOpportunities(
          env,
          state.focus ||
          "Find useful product opportunities for Shopper's Suggestions."
        );

      state.opportunities=opportunities;
      state.current_index=0;
      state.drafts=[];
      state.rejected=[];
      state.discovery_done=true;

      if(!opportunities.length) {
        await finishManagerRun(
          env,
          run.id,
          "completed",
          "No usable opportunities were returned.",
          state
        );

        const finished=await getManagerRun(
          env,
          run.id
        );

        return json({
          ok:true,
          done:true,
          run:finished
        });
      }

      await updateManagerRun(
        env,
        run.id,
        "researching",
        `Found ${opportunities.length} opportunities. Researching 1 of ${opportunities.length}...`,
        state
      );

      const updated=await getManagerRun(
        env,
        run.id
      );

      return json({
        ok:true,
        done:false,
        run:updated
      });

    } catch(error) {
      console.error(
        "Manager discovery failed:",
        error
      );

      await finishManagerRun(
        env,
        run.id,
        "failed",
        error?.message||String(error),
        state
      );

      const failed=await getManagerRun(
        env,
        run.id
      );

      return json({
        ok:true,
        done:true,
        run:failed
      });
    }
  }

  /*
    STEP 2:
    Research ONE opportunity.

    We deliberately process only one product per request.
  */
  if(run.stage==="researching") {
    const opportunities=
      Array.isArray(state.opportunities)
        ? state.opportunities
        : [];

    const index=Number.isInteger(
      Number(state.current_index)
    )
      ? Number(state.current_index)
      : 0;

    if(index>=opportunities.length) {
      await finishManagerRun(
        env,
        run.id,
        "completed",
        "Manager cycle completed.",
        state
      );

      const finished=await getManagerRun(
        env,
        run.id
      );

      return json({
        ok:true,
        done:true,
        run:finished
      });
    }

    const opportunity=opportunities[index];

    try {
      await updateManagerRun(
        env,
        run.id,
        "researching",
        `Researching opportunity ${index+1} of ${opportunities.length}...`,
        state
      );

      let researched;

      try {
        researched=
          await researchManagerProduct(
            env,
            opportunity
          );
      } catch(researchError) {
        /*
          Do not kill the entire Manager because
          one AI research request failed.

          Create a safe fallback research object.
        */
        console.error(
          "Research step failed:",
          researchError
        );

        researched={
          title:safeString(
            opportunity.title,
            "Untitled product opportunity"
          ),

          description:safeString(
            opportunity.reason,
            "Product opportunity requires further verification."
          ),

          category:normalizeCategory(
            opportunity.category
          ),

          target_customer:safeString(
            opportunity.target_customer
          ),

          problem_solved:safeString(
            opportunity.problem
          ),

          selling_points:[],

          verification_notes:[
            "Research request failed.",
            "Verify product information manually before publishing."
          ],

          affiliate_url:"",
          image_urls:[],
          video_url:""
        };

        await addLog(
          env,
          "error",
          "Manager research fallback used",
          {
            run_id:run.id,
            opportunity_index:index,
            error:researchError?.message ||
              String(researchError)
          }
        );
      }

      const title=
        researched.title ||
        opportunity.title ||
        "";

      const duplicate=
        await isManagerDuplicate(
          env,
          title
        );

      if(duplicate) {
        state.rejected.push({
          title,
          reason:"Possible duplicate"
        });

        state.current_index=index+1;

      } else {
        const draft=
          await createManagerDraft(
            env,
            researched,
            run.id
          );

        state.drafts.push(draft);

        state.current_index=index+1;
      }

      if(state.current_index>=opportunities.length) {
        await finishManagerRun(
          env,
          run.id,
          "completed",
          "Manager cycle completed.",
          state
        );

        const finished=await getManagerRun(
          env,
          run.id
        );

        return json({
          ok:true,
          done:true,
          run:finished
        });
      }

      await updateManagerRun(
        env,
        run.id,
        "researching",
        `Researching opportunity ${state.current_index+1} of ${opportunities.length}...`,
        state
      );

      const updated=await getManagerRun(
        env,
        run.id
      );

      return json({
        ok:true,
        done:false,
        run:updated
      });

    } catch(error) {
      console.error(
        "Manager step failed:",
        error
      );

      await finishManagerRun(
        env,
        run.id,
        "failed",
        error?.message||String(error),
        state
      );

      await addLog(
        env,
        "error",
        "Manager step failed",
        {
          run_id:run.id,
          opportunity_index:index,
          error:error?.message||String(error)
        }
      );

      const failed=await getManagerRun(
        env,
        run.id
      );

      return json({
        ok:true,
        done:true,
        run:failed
      });
    }
  }

  /*
    Unexpected stage.
  */
  await finishManagerRun(
    env,
    run.id,
    "failed",
    `Unknown Manager stage: ${run.stage}`,
    state
  );

  const failed=await getManagerRun(
    env,
    run.id
  );

  return json({
    ok:true,
    done:true,
    run:failed
  });
}

async function getManagerRun(env,runId) {
  return await env.DB.prepare(`
    SELECT *
    FROM manager_runs
    WHERE id=?
    LIMIT 1
  `).bind(
    runId
  ).first();
}

async function updateManagerRun(
  env,
  runId,
  stage,
  message,
  resultState=null
) {
  const now=nowISO();

  let resultJson;

  if(resultState!==null) {
    resultJson=JSON.stringify(
      resultState
    );
  } else {
    const existing=
      await getManagerRun(
        env,
        runId
      );

    resultJson=
      existing?.result_json ||
      "{}";
  }

  await env.DB.prepare(`
    UPDATE manager_runs
    SET
      stage=?,
      message=?,
      result_json=?,
      updated_at=?
    WHERE id=?
      AND status='running'
  `).bind(
    stage,
    message,
    resultJson,
    now,
    runId
  ).run();
}

async function finishManagerRun(
  env,
  runId,
  status,
  message,
  resultState={}
) {
  const now=nowISO();

  await env.DB.prepare(`
    UPDATE manager_runs
    SET
      status=?,
      stage=?,
      message=?,
      result_json=?,
      updated_at=?,
      finished_at=?
    WHERE id=?
  `).bind(
    status,
    status==="completed"
      ? "completed"
      : "failed",
    message,
    JSON.stringify(
      resultState||{}
    ),
    now,
    now,
    runId
  ).run();
}

async function managerStatus(env) {
  /*
    Automatically clean stale runs here too.
    This protects the dashboard even if the user
    does not press Run Manager again.
  */

  await env.DB.prepare(`
    UPDATE manager_runs
    SET
      status='failed',
      stage='failed',
      message='Automatically stopped: stale Manager run.',
      updated_at=?,
      finished_at=?
    WHERE status='running'
      AND updated_at < datetime('now','-15 minutes')
  `).bind(
    nowISO(),
    nowISO()
  ).run();

  const run=await env.DB.prepare(`
    SELECT *
    FROM manager_runs
    ORDER BY started_at DESC
    LIMIT 1
  `).first();

  let parsed={};

  try {
    parsed=JSON.parse(
      run?.result_json||"{}"
    );
  } catch {
    parsed={};
  }

  return json({
    ok:true,
    run:run||null,
    state:parsed
  });
}

function parseJSONFromAI(text) {
  if(!text)
    return {};

  if(typeof text==="object")
    return text;

  let value=String(text).trim();

  /*
    Remove Markdown JSON fences.
  */
  value=value
    .replace(/^```json\s*/i,"")
    .replace(/^```\s*/i,"")
    .replace(/\s*```$/i,"")
    .trim();

  /*
    First attempt:
    complete response is JSON.
  */
  try {
    return JSON.parse(value);
  } catch {}

  /*
    Second attempt:
    find the first JSON object.
  */
  const first=value.indexOf("{");
  const last=value.lastIndexOf("}");

  if(first!==-1 && last>first) {
    try {
      return JSON.parse(
        value.slice(first,last+1)
      );
    } catch {}
  }

  /*
    Third attempt:
    find JSON array.
  */
  const firstArray=value.indexOf("[");
  const lastArray=value.lastIndexOf("]");

  if(firstArray!==-1 && lastArray>firstArray) {
    try {
      return JSON.parse(
        value.slice(
          firstArray,
          lastArray+1
        )
      );
    } catch {}
  }

  return {};
}

function normalizeCategory(value) {
  const clean=safeString(
    value,
    "Other"
  );

  const found=CATEGORIES.find(
    category =>
      category.toLowerCase()===
      clean.toLowerCase()
  );

  return found||"Other";
}

async function runScheduledManager(env) {
  try {
    if(!env.AI || !env.DB)
      return;

    const active=await env.DB.prepare(`
      SELECT id
      FROM manager_runs
      WHERE status='running'
      LIMIT 1
    `).first();

    if(active)
      return;

    const runId=createRunId();
    const now=nowISO();

    const focus=
      "Find useful, practical product opportunities for Shopper's Suggestions.";

    const state={
      focus,
      opportunities:[],
      current_index:0,
      drafts:[],
      rejected:[],
      discovery_done:false,
      scheduled:true
    };

    await env.DB.prepare(`
      INSERT INTO manager_runs
      (
        id,
        status,
        stage,
        message,
        result_json,
        started_at,
        updated_at
      )
      VALUES(
        ?,
        'running',
        'discovering',
        'Scheduled Manager run started.',
        ?,
        ?,
        ?
      )
    `).bind(
      runId,
      JSON.stringify(state),
      now,
      now
    ).run();

    await addLog(
      env,
      "info",
      "Scheduled Manager run created",
      {
        run_id:runId
      }
    );

    /*
      Cloudflare Cron has limited execution time,
      so process only the first bounded step here.

      The normal Manager UI continues subsequent
      steps through /api/manager/step.
    */

    await managerStep(
      new Request(
        "https://internal/api/manager/step",
        {
          method:"POST",
          body:JSON.stringify({
            run_id:runId
          }),
          headers:{
            "content-type":"application/json"
          }
        }
      ),
      env
    );

  } catch(error) {
    console.error(
      "Scheduled Manager failed:",
      error
    );

    await addLog(
      env,
      "error",
      "Scheduled Manager failed",
      {
        error:error?.message||String(error)
      }
    );
  }
}

async function runLegacyManagerStep(env,runId) {
  /*
    Kept as a compatibility helper.
    New requests should use managerStep().
  */

  return managerStep(
    new Request(
      "https://internal/api/manager/step",
      {
        method:"POST",
        body:JSON.stringify({
          run_id:runId
        }),
        headers:{
          "content-type":"application/json"
        }
      }
    ),
    env
  );
}
/* =========================================================
   FINAL MANAGER HELPERS
========================================================= */

async function updateManagerRun(
  env,
  runId,
  stage,
  message,
  resultState=null
) {
  let resultJson="{}";

  if(resultState!==null) {
    resultJson=JSON.stringify(resultState);
  } else {
    const current=await env.DB.prepare(`
      SELECT result_json
      FROM manager_runs
      WHERE id=?
      LIMIT 1
    `).bind(runId).first();

    resultJson=current?.result_json||"{}";
  }

  await env.DB.prepare(`
    UPDATE manager_runs
    SET
      stage=?,
      message=?,
      result_json=?,
      updated_at=?
    WHERE id=?
      AND status='running'
  `).bind(
    stage,
    message,
    resultJson,
    nowISO(),
    runId
  ).run();
}

async function finishManagerRun(
  env,
  runId,
  status,
  message,
  result={}
) {
  const now=nowISO();

  await env.DB.prepare(`
    UPDATE manager_runs
    SET
      status=?,
      stage=?,
      message=?,
      result_json=?,
      updated_at=?,
      finished_at=?
    WHERE id=?
  `).bind(
    status,
    status==="completed"
      ? "completed"
      : "failed",
    message,
    JSON.stringify(result||{}),
    now,
    now,
    runId
  ).run();
}

async function managerStatus(env) {
  await env.DB.prepare(`
    UPDATE manager_runs
    SET
      status='failed',
      stage='failed',
      message='Automatically stopped: stale Manager run.',
      updated_at=?,
      finished_at=?
    WHERE status='running'
      AND updated_at < datetime('now','-15 minutes')
  `).bind(
    nowISO(),
    nowISO()
  ).run();

  const latest=await env.DB.prepare(`
    SELECT *
    FROM manager_runs
    ORDER BY started_at DESC
    LIMIT 1
  `).first();

  let result={};

  try {
    result=JSON.parse(
      latest?.result_json||"{}"
    );
  } catch {
    result={};
  }

  return json({
    ok:true,
    run:latest
      ? {
          ...latest,
          result
        }
      : null
  });
}

/*
  Compatibility function for the scheduled Worker.

  The old version attempted to execute the entire Manager
  inside one long background operation. This version only
  performs one bounded step.
*/
async function executeManagerRun(env,runId,focus) {
  try {
    const existing=await getManagerRun(
      env,
      runId
    );

    if(!existing)
      return;

    let state={};

    try {
      state=JSON.parse(
        existing.result_json||"{}"
      );
    } catch {
      state={
        focus,
        opportunities:[],
        current_index:0,
        drafts:[],
        rejected:[],
        discovery_done:false
      };
    }

    if(!state.focus)
      state.focus=focus;

    await managerStep(
      new Request(
        "https://internal/api/manager/step",
        {
          method:"POST",
          headers:{
            "content-type":"application/json"
          },
          body:JSON.stringify({
            run_id:runId
          })
        }
      ),
      env
    );

  } catch(error) {
    console.error(
      "Scheduled manager step failed:",
      error
    );

    await finishManagerRun(
      env,
      runId,
      "failed",
      error?.message||String(error),
      {}
    );
  }
}

async function runScheduledManager(env) {
  try {
    await cleanExpiredChat(env);

    /*
      Reset tasks that were abandoned for more than
      two hours.
    */
    await env.DB.prepare(`
      UPDATE manager_tasks
      SET
        status='pending',
        updated_at=?
      WHERE status='running'
        AND updated_at < datetime('now','-2 hours')
    `).bind(
      nowISO()
    ).run();

    /*
      Clean stale Manager runs.
    */
    await env.DB.prepare(`
      UPDATE manager_runs
      SET
        status='failed',
        stage='failed',
        message='Automatically stopped: stale scheduled Manager run.',
        updated_at=?,
        finished_at=?
      WHERE status='running'
        AND updated_at < datetime('now','-15 minutes')
    `).bind(
      nowISO(),
      nowISO()
    ).run();

    const active=await env.DB.prepare(`
      SELECT id
      FROM manager_runs
      WHERE status='running'
      ORDER BY started_at DESC
      LIMIT 1
    `).first();

    if(active) {
      await addLog(
        env,
        "info",
        "Scheduled Manager skipped because a run is already active.",
        {
          run_id:active.id
        }
      );

      return;
    }

    if(!env.AI)
      return;

    const runId=createRunId();
    const now=nowISO();

    const state={
      focus:
        "Find useful, practical product opportunities for Shopper's Suggestions.",
      opportunities:[],
      current_index:0,
      drafts:[],
      rejected:[],
      discovery_done:false,
      scheduled:true
    };

    await env.DB.prepare(`
      INSERT INTO manager_runs
      (
        id,
        status,
        stage,
        message,
        result_json,
        started_at,
        updated_at
      )
      VALUES(
        ?,
        'running',
        'discovering',
        'Scheduled Manager cycle started.',
        ?,
        ?,
        ?
      )
    `).bind(
      runId,
      JSON.stringify(state),
      now,
      now
    ).run();

    await addLog(
      env,
      "info",
      "Scheduled Manager run created",
      {
        run_id:runId
      }
    );

    /*
      Cron performs one bounded step.
      The dashboard can continue the run.
    */
    await executeManagerRun(
      env,
      runId,
      state.focus
    );

  } catch(error) {
    console.error(
      "Scheduled Manager error:",
      error
    );

    await addLog(
      env,
      "error",
      "Scheduled Manager failed",
      {
        error:error?.message||String(error)
      }
    );
  }
}

/* =========================================================
   MANAGER PAGE
========================================================= */

function managerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">

<title>Shopper's Suggestions · AI Manager</title>

<style>
:root{
  --bg:#f5f7fb;
  --card:rgba(255,255,255,.84);
  --ink:#111827;
  --muted:#6b7280;
  --line:#e5e7eb;
  --orange:#ff7a00;
  --blue:#1557a6;
  --green:#16a34a;
}

*{
  box-sizing:border-box;
}

body{
  margin:0;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  color:var(--ink);
  background:
    radial-gradient(
      circle at 10% 0%,
      rgba(255,122,0,.16),
      transparent 28%
    ),
    radial-gradient(
      circle at 90% 100%,
      rgba(21,87,166,.15),
      transparent 30%
    ),
    var(--bg);
  min-height:100vh;
}

header{
  position:sticky;
  top:0;
  z-index:10;
  backdrop-filter:blur(20px);
  background:rgba(255,255,255,.78);
  border-bottom:1px solid var(--line);
  padding:14px 18px;
}

.header-inner{
  max-width:1250px;
  margin:auto;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:14px;
}

.brand-wrap{
  display:flex;
  align-items:center;
  gap:12px;
}

.logo{
  width:42px;
  height:42px;
  object-fit:contain;
  border-radius:12px;
  background:#fff;
}

.brand{
  font-weight:850;
  font-size:18px;
}

.sub{
  font-size:11px;
  color:var(--muted);
}

.status-dot{
  display:inline-flex;
  align-items:center;
  gap:7px;
  font-size:12px;
  color:var(--green);
}

.dot{
  width:8px;
  height:8px;
  border-radius:50%;
  background:var(--green);
  box-shadow:0 0 0 5px rgba(22,163,74,.1);
}

main{
  max-width:1250px;
  margin:auto;
  padding:24px 16px 70px;
}

.hero{
  border:1px solid var(--line);
  border-radius:28px;
  padding:25px;
  background:
    linear-gradient(
      135deg,
      rgba(255,255,255,.94),
      rgba(255,255,255,.62)
    );
  box-shadow:0 18px 55px rgba(0,0,0,.07);
  margin-bottom:16px;
}

.hero h1{
  font-size:clamp(30px,6vw,52px);
  margin:0 0 8px;
  letter-spacing:-2px;
}

.hero p{
  color:var(--muted);
  max-width:760px;
  line-height:1.55;
}

.actions{
  display:flex;
  gap:9px;
  flex-wrap:wrap;
}

button{
  border:0;
  border-radius:13px;
  padding:11px 15px;
  font-weight:750;
  cursor:pointer;
  background:#111827;
  color:#fff;
  min-height:44px;
}

button.secondary{
  background:#eef1f5;
  color:#111827;
}

button.orange{
  background:
    linear-gradient(
      135deg,
      var(--orange),
      #ff9f43
    );
}

button:disabled{
  opacity:.55;
  cursor:not-allowed;
}

.grid{
  display:grid;
  grid-template-columns:
    repeat(auto-fit,minmax(280px,1fr));
  gap:15px;
}

.wide{
  grid-column:1/-1;
}

.card{
  background:var(--card);
  border:1px solid var(--line);
  border-radius:22px;
  padding:19px;
  box-shadow:0 12px 42px rgba(0,0,0,.055);
  backdrop-filter:blur(16px);
}

.card h2{
  margin:0 0 5px;
}

.small{
  font-size:12px;
  color:var(--muted);
}

.stats{
  display:grid;
  grid-template-columns:
    repeat(5,1fr);
  gap:10px;
  margin-top:15px;
}

.stat{
  padding:15px;
  border:1px solid var(--line);
  border-radius:16px;
  background:rgba(255,255,255,.58);
}

.stat b{
  display:block;
  font-size:27px;
  margin-top:5px;
}

textarea,
input{
  width:100%;
  border:1px solid #d9dde5;
  border-radius:13px;
  padding:12px 13px;
  font:inherit;
  outline:none;
  background:rgba(255,255,255,.8);
  margin-top:9px;
}

textarea{
  min-height:120px;
  resize:vertical;
}

.chat{
  height:390px;
  overflow:auto;
  display:flex;
  flex-direction:column;
  gap:9px;
}

.msg{
  padding:11px 13px;
  border-radius:15px;
  max-width:90%;
  white-space:pre-wrap;
  line-height:1.5;
}

.msg.user{
  align-self:flex-end;
  background:#111827;
  color:#fff;
}

.msg.assistant{
  align-self:flex-start;
  background:#eef1f5;
}

pre{
  white-space:pre-wrap;
  word-break:break-word;
  line-height:1.5;
  font:
    13px/1.55
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}

.run{
  border-left:4px solid var(--orange);
}

.pill{
  display:inline-block;
  padding:5px 9px;
  border-radius:999px;
  background:#eef1f5;
  font-size:11px;
  font-weight:750;
}

.pill.good{
  background:#dcfce7;
  color:#166534;
}

.pill.warn{
  background:#ffedd5;
  color:#9a3412;
}

@media(max-width:760px){
  .stats{
    grid-template-columns:repeat(2,1fr);
  }

  .stats .stat:last-child{
    grid-column:1/-1;
  }

  .hero{
    padding:20px;
  }

  .brand{
    font-size:15px;
  }
}
</style>
</head>

<body>

<header>
<div class="header-inner">

<div class="brand-wrap">

<img
  class="logo"
  src="https://raw.githubusercontent.com/shop-now-with/Shopper-s-suggestions/main/2E7A6582-42BB-48D4-84D8-71C3DA3ED841.jpeg"
  alt="Shopper's Suggestions"
>

<div>
<div class="brand">
Shopper's Suggestions
</div>

<div class="sub">
AI Manager Control Center
</div>
</div>

</div>

<div class="status-dot">
<span class="dot"></span>
Online
</div>

</div>
</header>

<main>

<section class="hero">

<div class="small">
AUTONOMOUS RESEARCH ENGINE
</div>

<h1>
Find. Research. Draft.
</h1>

<p>
The Manager discovers product opportunities,
researches them with AI, checks for duplicates
and creates research drafts. Publishing remains
a verification step.
</p>

<div class="actions">

<button
  class="orange"
  id="runManager"
>
▶ Run Manager
</button>

<button
  class="secondary"
  id="refresh"
>
↻ Refresh
</button>

</div>

</section>

<div class="grid">

<section class="card wide">

<h2>
Live Manager Status
</h2>

<div class="small">
Latest manager cycle and current stage.
</div>

<div
  id="runStatus"
  class="run"
  style="
    margin-top:13px;
    padding:15px;
    border-radius:16px;
    background:rgba(255,255,255,.55)
  "
>
Loading...
</div>

</section>

<section class="card wide">

<h2>
Dashboard
</h2>

<div class="stats">

<div class="stat">
<span class="small">Products</span>
<b id="products">—</b>
</div>

<div class="stat">
<span class="small">Published</span>
<b id="published">—</b>
</div>

<div class="stat">
<span class="small">Drafts</span>
<b id="drafts">—</b>
</div>

<div class="stat">
<span class="small">Active Tasks</span>
<b id="tasks">—</b>
</div>

<div class="stat">
<span class="small">Logs</span>
<b id="logs">—</b>
</div>

</div>

</section>

<section class="card">

<h2>
AI Chat
</h2>

<div class="small">
Ask the Manager for ideas, research or strategy.
</div>

<div
  id="chat"
  class="chat"
  style="margin-top:12px"
></div>

<textarea
  id="message"
  placeholder="e.g. Find useful products for students and creators..."
></textarea>

<div class="actions">

<button id="send">
Send
</button>

<button
  id="reset"
  class="secondary"
>
Reset Chat
</button>

</div>

</section>

<section class="card">

<h2>
Product Research
</h2>

<div class="small">
Manual research tool.
</div>

<input
  id="researchInput"
  placeholder="Product or niche"
>

<button id="research">
Research
</button>

<pre id="researchResult"></pre>

</section>

<section class="card">

<h2>
Marketing
</h2>

<input
  id="marketingTitle"
  placeholder="Product title"
>

<textarea
  id="marketingDescription"
  placeholder="Product description"
></textarea>

<button id="marketing">
Generate Marketing
</button>

<pre id="marketingResult"></pre>

</section>

<section class="card">

<h2>
GitHub
</h2>

<div class="small">
Checks the configured media repository connection.
</div>

<button id="github">
Test GitHub
</button>

<pre id="integrationResult"></pre>

</section>

<section class="card wide">

<h2>
Manager Rules
</h2>

<div class="small">
AI-generated drafts are research candidates only.
Affiliate URLs, product identity, media rights,
prices, availability and claims must be verified
before publishing.
</div>

</section>

</div>
</main>

<script>

const $=id=>
  document.getElementById(id);

async function api(url,options={}){

  const response=await fetch(
    url,
    {
      headers:{
        "Content-Type":"application/json",
        ...(options.headers||{})
      },
      ...options
    }
  );

  const data=await response.json();

  if(!response.ok)
    throw new Error(
      data.error||
      "Request failed"
    );

  return data;
}

function escapeHtml(value){

  return String(
    value??""
  ).replace(
    /[&<>"']/g,
    c=>({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      '"':"&quot;",
      "'":"&#39;"
    }[c])
  );
}

async function loadDashboard(){

  try{

    const d=
      await api(
        "/api/dashboard"
      );

    $("products").textContent=
      d.products;

    $("published").textContent=
      d.published_products;

    $("drafts").textContent=
      d.drafts;

    $("tasks").textContent=
      d.active_tasks;

    $("logs").textContent=
      d.logs;

    renderRun(
      d.latest_run
    );

  }catch(error){

    $("runStatus").textContent=
      error.message;
  }
}

async function loadRunStatus(){

  try{

    const d=
      await api(
        "/api/manager/status"
      );

    renderRun(
      d.run
    );

    return d;

  }catch(error){

    $("runStatus").textContent=
      error.message;

    return null;
  }
}

function renderRun(run){

  if(!run){

    $("runStatus").innerHTML=
      "<span class='pill'>No manager run yet</span>";

    return;
  }

  let result={};

  try{

    result=
      typeof run.result==="object"
        ? run.result
        : JSON.parse(
            run.result_json||"{}"
          );

  }catch{
    result={};
  }

  const statusClass=
    run.status==="completed"
      ? "good"
      : run.status==="failed"
        ? "warn"
        : "";

  $("runStatus").innerHTML=

    "<div style='display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap'>"+

      "<strong>"+
      escapeHtml(
        run.message||
        "Manager run"
      )+
      "</strong>"+

      "<span class='pill "+
      statusClass+
      "'>"+
      escapeHtml(
        run.status
      )+
      "</span>"+

    "</div>"+

    "<div class='small' style='margin-top:7px'>"+
    "Stage: "+
    escapeHtml(
      run.stage||"—"
    )+
    " · Started: "+
    escapeHtml(
      run.started_at||"—"
    )+
    "</div>"+

    (
      Object.keys(result).length
      ?
      "<pre>"+
      escapeHtml(
        JSON.stringify(
          result,
          null,
          2
        )
      )+
      "</pre>"
      :
      ""
    );
}

/*
  IMPORTANT FIX:

  After creating the Manager run,
  repeatedly call /api/manager/step.

  The previous version only called
  /api/manager/status, which could never
  advance the Manager.
*/

let managerPolling=false;

async function runManager(){

  if(managerPolling)
    return;

  $("runManager").disabled=true;
  $("runManager").textContent=
    "Starting...";

  try{

    const d=
      await api(
        "/api/manager/run",
        {
          method:"POST",
          body:JSON.stringify({})
        }
      );

    renderRun({
      status:"running",
      stage:"starting",
      message:d.message,
      started_at:
        new Date().toISOString(),
      result_json:"{}"
    });

    managerPolling=true;

    await pumpManager(
      d.run_id
    );

  }catch(error){

    alert(
      error.message
    );

  }finally{

    managerPolling=false;

    $("runManager").disabled=false;

    $("runManager").textContent=
      "▶ Run Manager";
  }
}

async function pumpManager(runId){

  while(true){

    try{

      const d=
        await api(
          "/api/manager/step",
          {
            method:"POST",
            body:JSON.stringify({
              run_id:runId
            })
          }
        );

      if(d.run)
        renderRun(
          d.run
        );

      await loadDashboard();

      if(
        d.done ||
        d.run?.status==="completed" ||
        d.run?.status==="failed"
      ){
        break;
      }

      /*
        Give Cloudflare a short gap
        between AI operations.
      */

      await new Promise(
        resolve=>
          setTimeout(
            resolve,
            1500
          )
      );

    }catch(error){

      /*
        If the request fails,
        refresh status once.

        This prevents a temporary
        network error from creating
        another Manager run.
      */

      const status=
        await loadRunStatus();

      if(
        status?.run?.status!=="running"
      ){
        break;
      }

      await new Promise(
        resolve=>
          setTimeout(
            resolve,
            2500
          )
      );
    }
  }

  await loadDashboard();
  await loadRunStatus();
}

function addMessage(
  role,
  content
){

  const div=
    document.createElement(
      "div"
    );

  div.className=
    "msg "+
    (
      role==="user"
        ? "user"
        : "assistant"
    );

  div.textContent=
    content;

  $("chat")
    .appendChild(div);

  $("chat").scrollTop=
    $("chat").scrollHeight;
}

async function sendMessage(){

  const input=
    $("message");

  const message=
    input.value.trim();

  if(!message)
    return;

  input.value="";

  addMessage(
    "user",
    message
  );

  try{

    const d=
      await api(
        "/api/ai/chat",
        {
          method:"POST",
          body:JSON.stringify({
            message
          })
        }
      );

    addMessage(
      "assistant",
      d.answer
    );

  }catch(error){

    addMessage(
      "assistant",
      "Error: "+
      error.message
    );
  }
}

async function resetChat(){

  try{

    await api(
      "/api/ai/chat/reset",
      {
        method:"POST"
      }
    );

    $("chat").innerHTML="";

    addMessage(
      "assistant",
      "Chat reset."
    );

  }catch(error){

    addMessage(
      "assistant",
      "Error: "+
      error.message
    );
  }
}

async function doResearch(){

  const query=
    $("researchInput")
      .value
      .trim();

  if(!query)
    return;

  $("researchResult").textContent=
    "Researching...";

  try{

    const d=
      await api(
        "/api/research",
        {
          method:"POST",
          body:JSON.stringify({
            query
          })
        }
      );

    $("researchResult").textContent=
      d.result;

  }catch(error){

    $("researchResult").textContent=
      error.message;
  }
}

async function doMarketing(){

  $("marketingResult")
    .textContent=
    "Generating...";

  try{

    const d=
      await api(
        "/api/marketing",
        {
          method:"POST",
          body:JSON.stringify({

            title:
              $("marketingTitle")
                .value
                .trim(),

            description:
              $("marketingDescription")
                .value
                .trim(),

            platform:
              "Instagram"

          })
        }
      );

    $("marketingResult")
      .textContent=
      d.result;

  }catch(error){

    $("marketingResult")
      .textContent=
      error.message;
  }
}

async function testGitHub(){

  $("integrationResult")
    .textContent=
    "Testing...";

  try{

    const d=
      await api(
        "/api/integrations/github/test"
      );

    $("integrationResult")
      .textContent=
      JSON.stringify(
        d,
        null,
        2
      );

  }catch(error){

    $("integrationResult")
      .textContent=
      error.message;
  }
}

$("runManager")
  .addEventListener(
    "click",
    runManager
  );

$("refresh")
  .addEventListener(
    "click",
    ()=>{
      loadDashboard();
      loadRunStatus();
    }
  );

$("send")
  .addEventListener(
    "click",
    sendMessage
  );

$("reset")
  .addEventListener(
    "click",
    resetChat
  );

$("research")
  .addEventListener(
    "click",
    doResearch
  );

$("marketing")
  .addEventListener(
    "click",
    doMarketing
  );

$("github")
  .addEventListener(
    "click",
    testGitHub
  );

$("message")
  .addEventListener(
    "keydown",
    event=>{
      if(
        event.key==="Enter" &&
        !event.shiftKey
      ){
        event.preventDefault();
        sendMessage();
      }
    }
  );

loadDashboard();

addMessage(
  "assistant",
  "Shopper's Suggestions AI Manager is online. Run the Manager when you're ready."
);

setInterval(
  loadRunStatus,
  5000
);

</script>

</body>
</html>`;
}
