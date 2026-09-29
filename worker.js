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
