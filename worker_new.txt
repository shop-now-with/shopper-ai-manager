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
        return runManager(request,env);

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
      return json({ok:false,error:error?.message || String(error)},500);
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
  try { return await request.json(); }
  catch { return {}; }
}

function safeString(value,fallback="") {
  if(value===null || value===undefined) return fallback;
  return String(value).trim();
}

function nowISO() {
  return new Date().toISOString();
}

async function ensureTables(env) {
  if(!env.DB) throw new Error("D1 database binding DB is missing.");

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
    return json({ok:false,error:"Workers AI binding AI is missing."},500);

  const body=await readJson(request);
  const message=safeString(body.message||body.prompt||body.content);

  if(!message)
    return json({ok:false,error:"Message is required."},400);

  await cleanExpiredChat(env);

  const historyResult=await env.DB.prepare(`
    SELECT role,content
    FROM manager_chat_messages
    WHERE session_id=?
      AND expires_at>datetime('now')
    ORDER BY id DESC
    LIMIT ?
  `).bind(CHAT_SESSION_ID,MAX_HISTORY).all();

  const history=(historyResult.results||[])
    .reverse()
    .map(row=>({role:row.role,content:row.content}));

  await env.DB.prepare(`
    INSERT INTO manager_chat_messages
    (session_id,role,content,created_at,expires_at)
    VALUES(?,?,?,datetime('now'),datetime('now','+24 hours'))
  `).bind(CHAT_SESSION_ID,"user",message).run();

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
        {role:"system",content:systemPrompt},
        ...history,
        {role:"user",content:message}
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
    VALUES(?,?,?,datetime('now'),datetime('now','+24 hours'))
  `).bind(CHAT_SESSION_ID,"assistant",answer).run();

  await addLog(env,"info","AI chat completed",{session_id:CHAT_SESSION_ID});

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
  `).bind(CHAT_SESSION_ID).run();

  await addLog(env,"info","AI chat reset",{});

  return json({ok:true,reset:true});
}

async function dashboard(env) {
  const [products,published,drafts,tasks,logs,run]=await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM products`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM products WHERE published=1`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM manager_drafts WHERE status='draft'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM manager_tasks WHERE status IN ('pending','running')`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM manager_logs`).first(),
    env.DB.prepare(`SELECT * FROM manager_runs ORDER BY started_at DESC LIMIT 1`).first()
  ]);

  return json({
    ok:true,
    products:Number(products?.count||0),
    published_products:Number(published?.count||0),
    drafts:Number(drafts?.count||0),
    active_tasks:Number(tasks?.count||0),
    logs:Number(logs?.count||0),
    latest_run:run||null,
    ai:!!env.AI,
    database:!!env.DB
  });
}

async function getProducts(env) {
  const result=await env.DB.prepare(`
    SELECT * FROM products
    WHERE published=1
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  return json({ok:true,products:result.results||[]});
}

async function getProduct(env,id) {
  const product=await env.DB.prepare(`
    SELECT * FROM products
    WHERE id=?
    LIMIT 1
  `).bind(id).first();

  if(!product)
    return json({ok:false,error:"Product not found."},404);

  return json({ok:true,product});
}

async function research(request,env) {
  const body=await readJson(request);
  const query=safeString(body.query||body.product||body.topic);

  if(!query)
    return json({ok:false,error:"Research query is required."},400);

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

  await addLog(env,"info","Product research completed",{query});

  return json({ok:true,query,result:answer});
}

async function classifyProduct(request,env) {
  const body=await readJson(request);
  const title=safeString(body.title);
  const description=safeString(body.description);

  if(!title&&!description)
    return json({ok:false,error:"Product title or description is required."},400);

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

  return json({ok:true,result:answer});
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

  return json({ok:true,result:answer});
}

async function marketing(request,env) {
  const body=await readJson(request);
  const title=safeString(body.title);
  const description=safeString(body.description);
  const platform=safeString(body.platform,"Instagram");

  if(!title&&!description)
    return json({ok:false,error:"Product information is required."},400);

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

  await addLog(env,"info","Marketing content generated",{product:title,platform});

  return json({ok:true,result:answer});
}

async function getDrafts(env) {
  const result=await env.DB.prepare(`
    SELECT * FROM manager_drafts
    ORDER BY id DESC
    LIMIT 100
  `).all();

  return json({ok:true,drafts:result.results||[]});
}

async function createDraft(request,env) {
  const body=await readJson(request);

  return insertManagerDraft(env,{
    title:safeString(body.title),
    description:safeString(body.description),
    affiliate_url:safeString(body.affiliate_url||body.affiliateUrl),
    category:safeString(body.category,"Other"),
    image_urls:Array.isArray(body.image_urls)
      ? body.image_urls
      : Array.isArray(body.images)
        ? body.images
        : [],
    video_url:safeString(body.video_url||body.videoUrl),
    source:"manual"
  });
}

async function insertManagerDraft(env,data) {
  const now=nowISO();

  const result=await env.DB.prepare(`
    INSERT INTO manager_drafts
    (title,description,affiliate_url,category,image_urls,video_url,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'draft',?,?)
  `).bind(
    data.title||"",
    data.description||"",
    data.affiliate_url||"",
    data.category||"Other",
    JSON.stringify(Array.isArray(data.image_urls)?data.image_urls:[]),
    data.video_url||"",
    now,
    now
  ).run();

  await addLog(env,"info","Draft created",{
    id:result.meta?.last_row_id,
    source:data.source||"manual"
  });

  return json({ok:true,id:result.meta?.last_row_id});
}

async function publishDraft(env,id) {
  const draft=await env.DB.prepare(`
    SELECT * FROM manager_drafts
    WHERE id=?
    LIMIT 1
  `).bind(id).first();

  if(!draft)
    return json({ok:false,error:"Draft not found."},404);

  if(!draft.affiliate_url)
    return json({
      ok:false,
      error:"This draft has no verified affiliate URL yet. Add and verify it before publishing."
    },400);

  let images=[];
  try { images=JSON.parse(draft.image_urls||"[]"); }
  catch { images=[]; }

  while(images.length<5) images.push("");

  const now=nowISO();

  const result=await env.DB.prepare(`
    INSERT INTO products
    (title,description,affiliate_url,category,
     image1_url,image2_url,image3_url,image4_url,image5_url,
     published,created_at,updated_at,video_url,featured)
    VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,0)
  `).bind(
    draft.title,
    draft.description,
    draft.affiliate_url,
    draft.category,
    images[0]||"",
    images[1]||"",
    images[2]||"",
    images[3]||"",
    images[4]||"",
    now,
    now,
    draft.video_url||""
  ).run();

  await env.DB.prepare(`
    UPDATE manager_drafts
    SET status='published',updated_at=?
    WHERE id=?
  `).bind(now,id).run();

  await addLog(env,"info","Draft published",{
    draft_id:id,
    product_id:result.meta?.last_row_id
  });

  return json({
    ok:true,
    published:true,
    product_id:result.meta?.last_row_id
  });
}

async function getTasks(env) {
  const result=await env.DB.prepare(`
    SELECT * FROM manager_tasks
    ORDER BY id DESC
    LIMIT 100
  `).all();

  return json({ok:true,tasks:result.results||[]});
}

async function createTask(request,env) {
  const body=await readJson(request);
  const now=nowISO();

  const result=await env.DB.prepare(`
    INSERT INTO manager_tasks
    (type,status,data_json,result_json,created_at,updated_at)
    VALUES(?,'pending',?,'{}',?,?)
  `).bind(
    safeString(body.type,"general"),
    JSON.stringify(body.data||body),
    now,
    now
  ).run();

  return json({ok:true,id:result.meta?.last_row_id});
}

async function getLogs(env) {
  const result=await env.DB.prepare(`
    SELECT * FROM manager_logs
    ORDER BY id DESC
    LIMIT 100
  `).all();

  return json({ok:true,logs:result.results||[]});
}

async function addLog(env,level,message,data={}) {
  try {
    await env.DB.prepare(`
      INSERT INTO manager_logs
      (level,message,data_json,created_at)
      VALUES(?,?,?,?)
    `).bind(
      level,
      message,
      JSON.stringify(data),
      nowISO()
    ).run();
  } catch(error) {
    console.error("Logging failed:",error);
  }
}

async function integrations(env) {
  return json({
    ok:true,
    website:{
      connected:!!env.WEBSITE_URL,
      url:env.WEBSITE_URL||""
    },
    github:{
      configured:
        !!env.GITHUB_OWNER &&
        !!env.GITHUB_REPO &&
        !!env.GITHUB_BRANCH
    },
    instagram:{
      connected:false,
      message:"Requires authorized Meta/Instagram integration."
    },
    affiliate:{
      connected:false,
      message:"Requires authorized affiliate-platform integration."
    },
    ai:{
      connected:!!env.AI,
      model:MODEL
    },
    database:{
      connected:!!env.DB
    }
  });
}

async function testGitHub(env) {
  if(!env.GITHUB_OWNER||!env.GITHUB_REPO)
    return json({
      ok:false,
      connected:false,
      message:"GITHUB_OWNER or GITHUB_REPO is missing."
    });

  if(!env.GITHUB_TOKEN)
    return json({
      ok:false,
      connected:false,
      message:"GITHUB_TOKEN secret is missing."
    });

  const response=await fetch(
    `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`,
    {
      headers:{
        Authorization:`Bearer ${env.GITHUB_TOKEN}`,
        Accept:"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28",
        "User-Agent":"shopper-ai-manager"
      }
    }
  );

  const data=await response.json();

  if(!response.ok)
    return json({
      ok:false,
      connected:false,
      status:response.status,
      error:data?.message||"GitHub request failed."
    });

  return json({
    ok:true,
    connected:true,
    repository:data.full_name,
    private:data.private,
    default_branch:data.default_branch
  });
}

function aiErrorInfo(error) {
  const message=String(error?.message||error||"");
  const status=Number(error?.status||error?.statusCode||0);
  const code=Number(error?.code||error?.errorCode||0);
  return {message,status,code};
}

function isRetryableAIError(error) {
  const info=aiErrorInfo(error);
  const text=info.message.toLowerCase();
  return info.status===429 || info.code===3040 ||
    text.includes("out of capacity") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("temporarily unavailable") ||
    text.includes("capacity");
}

async function runAI(env,prompt) {
  if(!env.AI)
    throw new Error("Workers AI binding AI is missing.");

  let lastError=null;

  for(let attempt=0;attempt<3;attempt++) {
    try {
      const result=await env.AI.run(MODEL,{
        messages:[
          {
            role:"system",
            content:"You are a practical AI manager for Shopper's Suggestions. Do not invent facts, URLs, prices, statistics, or completed actions."
          },
          {role:"user",content:prompt}
        ],
        max_tokens:1400,
        temperature:.7
      },{rejectIfBusy:true});

      return result?.response||result?.text||result?.output_text||
        result?.choices?.[0]?.message?.content||JSON.stringify(result);
    } catch(error) {
      lastError=error;
      if(!isRetryableAIError(error) || attempt===2) throw error;
      await new Promise(resolve=>setTimeout(resolve,1200*(attempt+1)));
    }
  }

  throw lastError||new Error("AI request failed.");
}

/* =========================================================
   MANAGER ENGINE
========================================================= */

function createRunId() {
  return `run_${Date.now()}_${crypto.randomUUID().slice(0,8)}`;
}

async function runManager(request,env) {
  if(!env.AI)
    return json({ok:false,error:"Workers AI binding AI is missing."},500);

  const body=await readJson(request);

  const focus=safeString(
    body.focus||body.query||body.topic,
    "Find useful product opportunities for Shopper's Suggestions."
  );

  const active=await env.DB.prepare(`
    SELECT id FROM manager_runs
    WHERE status='running'
    ORDER BY started_at DESC
    LIMIT 1
  `).first();

  if(active)
    return json({
      ok:true,
      started:false,
      already_active:true,
      run_id:active.id,
      message:"Manager is already running."
    });

  const runId=createRunId();
  const now=nowISO();

  const state={
    focus,
    opportunities:[],
    current_index:0,
    researched:null,
    drafts:[],
    rejected:[]
  };

  await env.DB.prepare(`
    INSERT INTO manager_runs
    (id,status,stage,message,result_json,started_at,updated_at)
    VALUES(?,'running','starting','Manager started',?,?,?)
  `).bind(
    runId,
    JSON.stringify(state),
    now,
    now
  ).run();

  await addLog(env,"info","Manager run started",{run_id:runId,focus});

  return json({
    ok:true,
    started:true,
    run_id:runId,
    message:"Manager started."
  });
}

async function managerStep(request,env) {
  if(!env.AI)
    return json({ok:false,error:"Workers AI binding AI is missing."},500);

  const body=await readJson(request);
  const runId=safeString(body.run_id||body.runId);

  if(!runId)
    return json({ok:false,error:"run_id is required."},400);

  const run=await env.DB.prepare(`
    SELECT * FROM manager_runs
    WHERE id=?
    LIMIT 1
  `).bind(runId).first();

  if(!run)
    return json({ok:false,error:"Manager run not found."},404);

  if(run.status!=="running")
    return json({ok:true,done:true,run:await getManagerRunObject(env,runId)});

  const age=Date.now()-Date.parse(run.updated_at||run.started_at||nowISO());

  if(Number.isFinite(age) && age>15*60*1000) {
    await finishManagerRun(
      env,
      runId,
      "failed",
      "Manager run stopped because it became stale.",
      {}
    );
    return json({ok:true,done:true,run:await getManagerRunObject(env,runId)});
  }

  let state={};
  try { state=JSON.parse(run.result_json||"{}"); }
  catch { state={}; }

  try {
    if(run.stage==="starting" || run.stage==="discovering") {
      await updateManagerRun(
        env,
        runId,
        "discovering",
        "Finding product opportunities..."
      );

      const opportunities=await discoverProductOpportunities(
        env,
        state.focus||"Find useful product opportunities for Shopper's Suggestions."
      );

      state.opportunities=opportunities;
      state.current_index=0;
      state.researched=null;
      state.drafts=Array.isArray(state.drafts)?state.drafts:[];
      state.rejected=Array.isArray(state.rejected)?state.rejected:[];

      if(!opportunities.length) {
        await finishManagerRun(
          env,
          runId,
          "completed",
          "No usable opportunities were returned.",
          state
        );
      } else {
        await updateManagerRun(
          env,
          runId,
          "researching",
          `Researching opportunity 1 of ${opportunities.length}...`,
          state
        );
      }
    } else if(run.stage==="researching") {
      const opportunities=Array.isArray(state.opportunities)?state.opportunities:[];
      const index=Math.max(0,Number(state.current_index||0));
      const opportunity=opportunities[index];

      if(!opportunity) {
        await finishManagerRun(
          env,
          runId,
          "completed",
          "Manager cycle completed.",
          state
        );
      } else {
        const researched=await researchManagerProduct(env,opportunity);
        const duplicate=await isManagerDuplicate(env,researched.title||opportunity.title||"");

        if(duplicate) {
          state.rejected.push({
            title:researched.title||opportunity.title,
            reason:"Possible duplicate"
          });
          state.current_index=index+1;
          state.researched=null;

          if(state.current_index>=opportunities.length) {
            await finishManagerRun(
              env,
              runId,
              "completed",
              "Manager cycle completed.",
              state
            );
          } else {
            await updateManagerRun(
              env,
              runId,
              "researching",
              `Researching opportunity ${state.current_index+1} of ${opportunities.length}...`,
              state
            );
          }
        } else {
          state.researched=researched;
          await updateManagerRun(
            env,
            runId,
            "creating_draft",
            `Creating draft ${index+1}...`,
            state
          );
        }
      }
    } else if(run.stage==="creating_draft") {
      const opportunities=Array.isArray(state.opportunities)?state.opportunities:[];
      const index=Math.max(0,Number(state.current_index||0));
      const researched=state.researched;

      if(!researched) {
        await updateManagerRun(
          env,
          runId,
          "researching",
          `Researching opportunity ${index+1} of ${opportunities.length}...`,
          state
        );
      } else {
        const draft=await createManagerDraft(env,researched,runId);
        state.drafts.push(draft);
        state.researched=null;
        state.current_index=index+1;

        if(state.current_index>=opportunities.length) {
          await finishManagerRun(
            env,
            runId,
            "completed",
            "Manager cycle completed.",
            state
          );

          await addLog(env,"info","Manager run completed",{
            run_id:runId,
            opportunities:opportunities.length,
            drafts_created:state.drafts.length
          });
        } else {
          await updateManagerRun(
            env,
            runId,
            "researching",
            `Researching opportunity ${state.current_index+1} of ${opportunities.length}...`,
            state
          );
        }
      }
    } else {
      await updateManagerRun(
        env,
        runId,
        "discovering",
        "Resuming manager cycle...",
        state
      );
    }
  } catch(error) {
    console.error("Manager step failed:",error);
    if(isRetryableAIError(error)) {
      await updateManagerRun(
        env,
        runId,
        run.stage||"discovering",
        "AI is temporarily busy. The Manager will retry this step.",
        state
      );
      await addLog(env,"warn","Manager AI temporarily busy",{
        run_id:runId,
        error:error?.message||String(error)
      });
    } else {
      await finishManagerRun(
        env,runId,"failed",error?.message||String(error),state
      );
      await addLog(env,"error","Manager step failed",{
        run_id:runId,
        error:error?.message||String(error)
      });
    }
  }

  const finalRun=await getManagerRunObject(env,runId);
  return json({
    ok:true,
    done:finalRun?.status!=="running",
    run:finalRun
  });
}

async function getManagerRunObject(env,runId) {
  const run=await env.DB.prepare(`
    SELECT * FROM manager_runs
    WHERE id=?
    LIMIT 1
  `).bind(runId).first();

  if(!run) return null;

  let result={};
  try { result=JSON.parse(run.result_json||"{}"); }
  catch {}

  return {...run,result};
}

async function discoverProductOpportunities(env,focus) {
  const raw=await runAI(env,`
You are the product-discovery agent for Shopper's Suggestions.

Find up to 5 promising PRODUCT OPPORTUNITIES based on this focus:

${focus}

Return JSON only:
{
  "opportunities":[
    {
      "title":"product type or opportunity",
      "reason":"why this is worth researching",
      "target_customer":"who may need it",
      "problem":"problem it addresses",
      "category":"one allowed category"
    }
  ]
}

Allowed categories:
${CATEGORIES.join(", ")}

Rules:
- Return product TYPES or opportunities, not invented exact listings.
- Do not invent exact prices, sales numbers, ratings, URLs, brands or trend statistics.
- Prefer practical products with a clear problem or need.
`);

  const parsed=parseJSONFromAI(raw);
  const list=Array.isArray(parsed?.opportunities)
    ? parsed.opportunities
    : [];

  return list.slice(0,5)
    .map(x=>({
      title:safeString(x.title),
      reason:safeString(x.reason),
      target_customer:safeString(x.target_customer),
      problem:safeString(x.problem),
      category:normalizeCategory(x.category)
    }))
    .filter(x=>x.title);
}

async function researchManagerProduct(env,opportunity) {
  const raw=await runAI(env,`
Research this product opportunity for an affiliate website.

Opportunity:
${JSON.stringify(opportunity,null,2)}

Return JSON only:
{
  "title":"clear product title",
  "description":"honest useful description",
  "category":"one allowed category",
  "target_customer":"target customer",
  "problem_solved":"problem solved",
  "selling_points":["point 1","point 2","point 3"],
  "verification_notes":["things that must be verified before publishing"],
  "affiliate_url":"",
  "image_urls":[],
  "video_url":""
}

Rules:
- Never invent an affiliate URL.
- Never invent image/video URLs.
- Do not claim current prices, ratings, rankings or sales numbers.
- This is a RESEARCH DRAFT, not a verified product listing.

Allowed categories:
${CATEGORIES.join(", ")}
`);

  const parsed=parseJSONFromAI(raw);

  return {
    title:safeString(parsed?.title,opportunity.title),
    description:safeString(parsed?.description,opportunity.reason),
    category:normalizeCategory(parsed?.category||opportunity.category),
    target_customer:safeString(parsed?.target_customer,opportunity.target_customer),
    problem_solved:safeString(parsed?.problem_solved,opportunity.problem),
    selling_points:Array.isArray(parsed?.selling_points)
      ? parsed.selling_points.slice(0,5)
      : [],
    verification_notes:Array.isArray(parsed?.verification_notes)
      ? parsed.verification_notes.slice(0,8)
      : [],
    affiliate_url:"",
    image_urls:[],
    video_url:""
  };
}

async function isManagerDuplicate(env,title) {
  const clean=title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g," ")
    .replace(/\s+/g," ")
    .trim();

  if(!clean) return false;

  const words=clean
    .split(" ")
    .filter(x=>x.length>2)
    .slice(0,8);

  if(!words.length) return false;

  const existing=await env.DB.prepare(`
    SELECT id,title FROM products
    WHERE lower(title) LIKE ?
    LIMIT 10
  `).bind(`%${words.slice(0,3).join("%")}%`).all();

  if((existing.results||[]).length) return true;

  const drafts=await env.DB.prepare(`
    SELECT id,title FROM manager_drafts
    WHERE status='draft'
    ORDER BY id DESC
    LIMIT 100
  `).all();

  return (drafts.results||[]).some(x=>{
    const t=safeString(x.title)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g," ")
      .replace(/\s+/g," ")
      .trim();

    const overlap=words.filter(w=>t.includes(w)).length;

    return overlap>=Math.min(3,words.length);
  });
}

async function createManagerDraft(env,researchResult,runId) {
  const verification=[
    ...(researchResult.verification_notes||[]),
    "Verify the exact product, seller and affiliate destination before publishing.",
    "Add media only when you have permission or a valid source to reuse it."
  ];

  const description=[
    researchResult.description,
    "",
    "Key points:",
    ...(researchResult.selling_points||[]).map(x=>`• ${x}`),
    "",
    "Verification:",
    ...verification.map(x=>`• ${x}`)
  ].join("\n");

  const now=nowISO();

  const result=await env.DB.prepare(`
    INSERT INTO manager_drafts
    (title,description,affiliate_url,category,image_urls,video_url,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'draft',?,?)
  `).bind(
    researchResult.title,
    description,
    "",
    researchResult.category,
    JSON.stringify([]),
    "",
    now,
    now
  ).run();

  const id=result.meta?.last_row_id;

  await addLog(env,"info","Manager created research draft",{
    run_id:runId,
    draft_id:id,
    title:researchResult.title
  });

  return {
    id,
    title:researchResult.title,
    category:researchResult.category,
    status:"draft",
    needs_verification:true
  };
}

function normalizeCategory(value) {
  const text=safeString(value);

  return CATEGORIES.find(
    x=>x.toLowerCase()===text.toLowerCase()
  )||"Other";
}

function parseJSONFromAI(raw) {
  if(typeof raw!=="string") return raw||{};

  let text=raw.trim();

  text=text
    .replace(/^```json\s*/i,"")
    .replace(/^```\s*/,"")
    .replace(/\s*```$/,"")
    .trim();

  try {
    return JSON.parse(text);
  } catch {}

  const first=text.indexOf("{");
  const last=text.lastIndexOf("}");

  if(first>=0&&last>first) {
    try {
      return JSON.parse(text.slice(first,last+1));
    } catch {}
  }

  return {};
}

async function updateManagerRun(env,runId,stage,message,state) {
  const values=[stage,message,nowISO(),runId];
  if(state!==undefined) {
    await env.DB.prepare(`
      UPDATE manager_runs
      SET stage=?,message=?,result_json=?,updated_at=?
      WHERE id=?
    `).bind(stage,message,JSON.stringify(state||{}),nowISO(),runId).run();
    return;
  }

  await env.DB.prepare(`
    UPDATE manager_runs
    SET stage=?,message=?,updated_at=?
    WHERE id=?
  `).bind(...values).run();
}

async function finishManagerRun(env,runId,status,message,result) {
  const now=nowISO();

  await env.DB.prepare(`
    UPDATE manager_runs
    SET status=?,stage=?,message=?,result_json=?,updated_at=?,finished_at=?
    WHERE id=?
  `).bind(
    status,
    status==="completed"?"completed":"failed",
    message,
    JSON.stringify(result||{}),
    now,
    now,
    runId
  ).run();
}

async function managerStatus(env) {
  const latest=await env.DB.prepare(`
    SELECT * FROM manager_runs
    ORDER BY started_at DESC
    LIMIT 1
  `).first();

  let parsed={};

  if(latest?.result_json) {
    try { parsed=JSON.parse(latest.result_json); }
    catch {}
  }

  return json({
    ok:true,
    run:latest
      ? {...latest,result:parsed}
      : null
  });
}

async function runScheduledManager(env) {
  try {
    await cleanExpiredChat(env);

    await env.DB.prepare(`
      UPDATE manager_tasks
      SET status='pending',updated_at=?
      WHERE status='running'
      AND updated_at < datetime('now','-2 hours')
    `).bind(nowISO()).run();

    const active=await env.DB.prepare(`
      SELECT id FROM manager_runs
      WHERE status='running'
      ORDER BY started_at DESC
      LIMIT 1
    `).first();

    if(active) {
      await addLog(env,"info","Scheduled cycle skipped because a manager run is already active",{run_id:active.id});
      return;
    }

    const runId=createRunId();
    const now=nowISO();
    const state={
      focus:"Find useful, practical product opportunities for Shopper's Suggestions.",
      opportunities:[],
      current_index:0,
      researched:null,
      drafts:[],
      rejected:[]
    };

    await env.DB.prepare(`
      INSERT INTO manager_runs
      (id,status,stage,message,result_json,started_at,updated_at)
      VALUES(?,'running','starting','Scheduled manager cycle started',?,?,?)
    `).bind(runId,JSON.stringify(state),now,now).run();

    await managerStep(
      new Request("https://manager.local/api/manager/step",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({run_id:runId})
      }),
      env
    );
  } catch(error) {
    console.error("Scheduled manager error:",error);

    await addLog(env,"error","Scheduled manager failed",{
      error:error?.message||String(error)
    });
  }
}

function managerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Shopper's Suggestions · AI Manager</title>
<style>
:root{--bg:#f5f7fb;--card:rgba(255,255,255,.84);--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--orange:#ff7a00;--blue:#1557a6;--green:#16a34a}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:radial-gradient(circle at 10% 0%,rgba(255,122,0,.16),transparent 28%),radial-gradient(circle at 90% 100%,rgba(21,87,166,.15),transparent 30%),var(--bg);min-height:100vh}
header{position:sticky;top:0;z-index:10;backdrop-filter:blur(20px);background:rgba(255,255,255,.78);border-bottom:1px solid var(--line);padding:14px 18px}
.header-inner{max-width:1250px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:14px}
.brand-wrap{display:flex;align-items:center;gap:12px}.logo{width:42px;height:42px;object-fit:contain;border-radius:12px;background:#fff}.brand{font-weight:850;font-size:18px}.sub{font-size:11px;color:var(--muted)}
.status-dot{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--green)}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 5px rgba(22,163,74,.1)}
main{max-width:1250px;margin:auto;padding:24px 16px 70px}
.hero{border:1px solid var(--line);border-radius:28px;padding:25px;background:linear-gradient(135deg,rgba(255,255,255,.94),rgba(255,255,255,.62));box-shadow:0 18px 55px rgba(0,0,0,.07);margin-bottom:16px}
.hero h1{font-size:clamp(30px,6vw,52px);margin:0 0 8px;letter-spacing:-2px}.hero p{color:var(--muted);max-width:760px;line-height:1.55}
.actions{display:flex;gap:9px;flex-wrap:wrap}
button{border:0;border-radius:13px;padding:11px 15px;font-weight:750;cursor:pointer;background:#111827;color:#fff;min-height:44px}button.secondary{background:#eef1f5;color:#111827}button.orange{background:linear-gradient(135deg,var(--orange),#ff9f43)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:15px}.wide{grid-column:1/-1}
.card{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:19px;box-shadow:0 12px 42px rgba(0,0,0,.055);backdrop-filter:blur(16px)}
.card h2{margin:0 0 5px}.small{font-size:12px;color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:15px}.stat{padding:15px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.58)}.stat b{display:block;font-size:27px;margin-top:5px}
textarea,input{width:100%;border:1px solid #d9dde5;border-radius:13px;padding:12px 13px;font:inherit;outline:none;background:rgba(255,255,255,.8);margin-top:9px}textarea{min-height:120px;resize:vertical}
.chat{height:390px;overflow:auto;display:flex;flex-direction:column;gap:9px}.msg{padding:11px 13px;border-radius:15px;max-width:90%;white-space:pre-wrap;line-height:1.5}.msg.user{align-self:flex-end;background:#111827;color:#fff}.msg.assistant{align-self:flex-start;background:#eef1f5}
pre{white-space:pre-wrap;word-break:break-word;line-height:1.5;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.run{border-left:4px solid var(--orange)}.pill{display:inline-block;padding:5px 9px;border-radius:999px;background:#eef1f5;font-size:11px;font-weight:750}.pill.good{background:#dcfce7;color:#166534}.pill.warn{background:#ffedd5;color:#9a3412}
@media(max-width:760px){.stats{grid-template-columns:repeat(2,1fr)}.stats .stat:last-child{grid-column:1/-1}.hero{padding:20px}.brand{font-size:15px}}
</style>
</head>
<body>
<header><div class="header-inner">
<div class="brand-wrap">
<img class="logo" src="https://raw.githubusercontent.com/shop-now-with/Shopper-s-suggestions/main/2E7A6582-42BB-48D4-84D8-71C3DA3ED841.jpeg" alt="Shopper's Suggestions">
<div><div class="brand">Shopper's Suggestions</div><div class="sub">AI Manager Control Center</div></div>
</div>
<div class="status-dot"><span class="dot"></span> Online</div>
</div></header>

<main>
<section class="hero">
<div class="small">AUTONOMOUS RESEARCH ENGINE</div>
<h1>Find. Research. Draft.</h1>
<p>The Manager discovers product opportunities, researches them with AI, checks for duplicates and creates research drafts. Publishing remains a verification step.</p>
<div class="actions">
<button class="orange" id="runManager">▶ Run Manager</button>
<button class="secondary" id="refresh">↻ Refresh</button>
</div>
</section>

<div class="grid">
<section class="card wide">
<h2>Live Manager Status</h2>
<div class="small">Latest manager cycle and current stage.</div>
<div id="runStatus" class="run" style="margin-top:13px;padding:15px;border-radius:16px;background:rgba(255,255,255,.55)">Loading...</div>
</section>

<section class="card wide">
<h2>Dashboard</h2>
<div class="stats">
<div class="stat"><span class="small">Products</span><b id="products">—</b></div>
<div class="stat"><span class="small">Published</span><b id="published">—</b></div>
<div class="stat"><span class="small">Drafts</span><b id="drafts">—</b></div>
<div class="stat"><span class="small">Active Tasks</span><b id="tasks">—</b></div>
<div class="stat"><span class="small">Logs</span><b id="logs">—</b></div>
</div>
</section>

<section class="card">
<h2>AI Chat</h2>
<div class="small">Ask the Manager for ideas, research or strategy.</div>
<div id="chat" class="chat" style="margin-top:12px"></div>
<textarea id="message" placeholder="e.g. Find useful products for students and creators..."></textarea>
<div class="actions"><button id="send">Send</button><button id="reset" class="secondary">Reset Chat</button></div>
</section>

<section class="card">
<h2>Product Research</h2>
<div class="small">Manual research tool.</div>
<input id="researchInput" placeholder="Product or niche">
<button id="research">Research</button>
<pre id="researchResult"></pre>
</section>

<section class="card">
<h2>Marketing</h2>
<input id="marketingTitle" placeholder="Product title">
<textarea id="marketingDescription" placeholder="Product description"></textarea>
<button id="marketing">Generate Marketing</button>
<pre id="marketingResult"></pre>
</section>

<section class="card">
<h2>GitHub</h2>
<div class="small">Checks the configured media repository connection.</div>
<button id="github">Test GitHub</button>
<pre id="integrationResult"></pre>
</section>

<section class="card wide">
<h2>Manager Rules</h2>
<div class="small">AI-generated drafts are research candidates only. Affiliate URLs, product identity, media rights, prices, availability and claims must be verified before publishing.</div>
</section>
</div>
</main>

<script>
const $=id=>document.getElementById(id);

async function api(url,options={}){
const response=await fetch(url,{headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
const data=await response.json();
if(!response.ok)throw new Error(data.error||"Request failed");
return data;
}

function escapeHtml(v){
return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function loadDashboard(){
try{
const d=await api("/api/dashboard");
$("products").textContent=d.products;
$("published").textContent=d.published_products;
$("drafts").textContent=d.drafts;
$("tasks").textContent=d.active_tasks;
$("logs").textContent=d.logs;
renderRun(d.latest_run);
}catch(e){$("runStatus").textContent=e.message}
}

async function loadRunStatus(){
try{
const d=await api("/api/manager/status");
renderRun(d.run);
}catch(e){$("runStatus").textContent=e.message}
}

function renderRun(run){
if(!run){
$("runStatus").innerHTML="<span class='pill'>No manager run yet</span>";
return;
}
let result={};
try{result=JSON.parse(run.result_json||"{}")}catch{}
const statusClass=run.status==="completed"?"good":run.status==="failed"?"warn":"";
$("runStatus").innerHTML=
"<div style='display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap'>"+
"<strong>"+escapeHtml(run.message||"Manager run")+"</strong>"+
"<span class='pill "+statusClass+"'>"+escapeHtml(run.status)+"</span>"+
"</div>"+
"<div class='small' style='margin-top:7px'>Stage: "+escapeHtml(run.stage||"—")+" · Started: "+escapeHtml(run.started_at||"—")+"</div>"+
(Object.keys(result).length?("<pre>"+escapeHtml(JSON.stringify(result,null,2))+"</pre>"):"");
}

let managerPolling=false;

async function runManager(){
$("runManager").disabled=true;
$("runManager").textContent="Starting...";
try{
const d=await api("/api/manager/run",{method:"POST",body:JSON.stringify({})});
await loadRunStatus();
managerPolling=true;
await pumpManager(d.run_id);
}catch(e){alert(e.message)}
finally{
managerPolling=false;
$("runManager").disabled=false;
$("runManager").textContent="▶ Run Manager";
await loadDashboard();
}
}

async function pumpManager(runId){
while(managerPolling){
try{
const d=await api("/api/manager/step",{
method:"POST",
body:JSON.stringify({run_id:runId})
});

if(d.run)renderRun(d.run);

if(
 d.done ||
 d.run?.status==="completed" ||
 d.run?.status==="failed"
){
break;
}

await new Promise(resolve=>setTimeout(resolve,1200));
}catch(e){
$("runStatus").innerHTML="<span class='pill warn'>"+escapeHtml(e.message)+"</span>";
break;
}
}
await loadDashboard();
}

function addMessage(role,content){
const div=document.createElement("div");
div.className="msg "+(role==="user"?"user":"assistant");
div.textContent=content;
$("chat").appendChild(div);
$("chat").scrollTop=$("chat").scrollHeight;
}

async function sendMessage(){
const input=$("message");
const message=input.value.trim();
if(!message)return;
input.value="";
addMessage("user",message);
try{
const d=await api("/api/ai/chat",{method:"POST",body:JSON.stringify({message})});
addMessage("assistant",d.answer);
}catch(e){addMessage("assistant","Error: "+e.message)}
}

async function resetChat(){
try{
await api("/api/ai/chat/reset",{method:"POST"});
$("chat").innerHTML="";
addMessage("assistant","Chat reset.");
}catch(e){addMessage("assistant","Error: "+e.message)}
}

async function doResearch(){
const query=$("researchInput").value.trim();
if(!query)return;
$("researchResult").textContent="Researching...";
try{
const d=await api("/api/research",{method:"POST",body:JSON.stringify({query})});
$("researchResult").textContent=d.result;
}catch(e){$("researchResult").textContent=e.message}
}

async function doMarketing(){
$("marketingResult").textContent="Generating...";
try{
const d=await api("/api/marketing",{method:"POST",body:JSON.stringify({
title:$("marketingTitle").value.trim(),
description:$("marketingDescription").value.trim(),
platform:"Instagram"
})});
$("marketingResult").textContent=d.result;
}catch(e){$("marketingResult").textContent=e.message}
}

async function testGitHub(){
$("integrationResult").textContent="Testing...";
try{
const d=await api("/api/integrations/github/test");
$("integrationResult").textContent=JSON.stringify(d,null,2);
}catch(e){$("integrationResult").textContent=e.message}
}

$("runManager").addEventListener("click",runManager);
$("refresh").addEventListener("click",()=>{loadDashboard();loadRunStatus()});
$("send").addEventListener("click",sendMessage);
$("reset").addEventListener("click",resetChat);
$("research").addEventListener("click",doResearch);
$("marketing").addEventListener("click",doMarketing);
$("github").addEventListener("click",testGitHub);

$("message").addEventListener("keydown",e=>{
if(e.key==="Enter"&&!e.shiftKey){
e.preventDefault();
sendMessage();
}
});

loadDashboard();
addMessage("assistant","Shopper's Suggestions AI Manager is online. Run the Manager when you're ready.");
setInterval(loadRunStatus,5000);
</script>
</body>
</html>`;
}
