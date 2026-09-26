const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store"
};

const CATEGORIES = [
  "Tech",
  "Home",
  "Fashion",
  "Beauty",
  "Gaming",
  "Sports",
  "Travel",
  "Kitchen",
  "Office",
  "Automotive",
  "Electronics",
  "Kids",
  "Pets",
  "Fitness",
  "Books",
  "Accessories",
  "Photography",
  "Creator",
  "Other"
];

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function text(data, status = 200) {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=UTF-8"
    }
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization"
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function requireManagerSecret(request, env) {
  const configured = env.MANAGER_SECRET;

  // During initial development we allow the dashboard to work
  // without a secret. Add MANAGER_SECRET later before exposing
  // the manager publicly.
  if (!configured) return true;

  const auth = request.headers.get("authorization") || "";

  return auth === `Bearer ${configured}`;
}

function clean(value, max = 5000) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/* -------------------------------------------------------
   DATABASE
------------------------------------------------------- */

async function ensureManagerTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manager_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manager_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manager_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      action TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manager_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      affiliate_url TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Other',
      image1_url TEXT NOT NULL DEFAULT '',
      image2_url TEXT NOT NULL DEFAULT '',
      image3_url TEXT NOT NULL DEFAULT '',
      image4_url TEXT NOT NULL DEFAULT '',
      image5_url TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '',
      marketing_json TEXT NOT NULL DEFAULT '{}',
      source_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function log(env, level, action, message, data = {}) {
  try {
    await env.DB.prepare(`
      INSERT INTO manager_logs
      (level, action, message, data_json)
      VALUES (?, ?, ?, ?)
    `)
      .bind(
        level,
        action,
        clean(message, 2000),
        JSON.stringify(data)
      )
      .run();
  } catch {
    // Logging must never break the Manager.
  }
}

/* -------------------------------------------------------
   AI
------------------------------------------------------- */

async function askAI(env, prompt, options = {}) {
  if (!env.AI) {
    throw new Error("Workers AI binding is not connected.");
  }

  const result = await env.AI.run(
    options.model || AI_MODEL,
    {
      prompt,
      max_tokens: options.max_tokens || 1200,
      temperature: options.temperature ?? 0.3
    }
  );

  if (typeof result === "string") {
    return result;
  }

  return (
    result?.response ||
    result?.text ||
    JSON.stringify(result)
  );
}

async function askAIJSON(env, prompt, fallback = {}) {
  const raw = await askAI(env, `${prompt}

Return ONLY valid JSON.
Do not use Markdown fences.
Do not include commentary outside the JSON.`);

  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);

    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }

    return fallback;
  }
}

/* -------------------------------------------------------
   PRODUCT DATA
------------------------------------------------------- */

async function getProducts(env, limit = 50) {
  const result = await env.DB.prepare(`
    SELECT
      id,
      title,
      description,
      affiliate_url,
      category,
      image1_url,
      image2_url,
      image3_url,
      image4_url,
      image5_url,
      video_url,
      published,
      featured,
      created_at,
      updated_at
    FROM products
    ORDER BY created_at DESC
    LIMIT ?
  `)
    .bind(Math.min(Math.max(Number(limit) || 50, 1), 100))
    .all();

  return result.results || [];
}

async function getProduct(env, id) {
  return await env.DB.prepare(`
    SELECT *
    FROM products
    WHERE id = ?
    LIMIT 1
  `)
    .bind(id)
    .first();
}

/* -------------------------------------------------------
   AI PRODUCT ANALYSIS
------------------------------------------------------- */

async function classifyProduct(env, product) {
  const prompt = `
You are the product classification engine for Shopper's Suggestions.

Allowed categories:
${CATEGORIES.join(", ")}

Product:
Title: ${clean(product.title)}
Description: ${clean(product.description)}

Choose exactly one category from the allowed list.

Return:
{
  "category": "Tech",
  "reason": "short explanation"
}
`;

  return await askAIJSON(env, prompt, {
    category: "Other",
    reason: "Unable to classify."
  });
}

async function improveProduct(env, product) {
  const prompt = `
You are the content manager for Shopper's Suggestions.

Rewrite the product listing professionally.

Product title:
${clean(product.title)}

Current description:
${clean(product.description)}

Category:
${clean(product.category)}

Create:
- a clear useful title
- a concise persuasive description
- a short Instagram caption
- 5 relevant hashtags

Do not invent specifications, prices, discounts, guarantees,
reviews, certifications, or claims that were not supplied.

Return:
{
  "title": "",
  "description": "",
  "caption": "",
  "hashtags": []
}
`;

  return await askAIJSON(env, prompt, {
    title: product.title,
    description: product.description,
    caption: "",
    hashtags: []
  });
}

/* -------------------------------------------------------
   RESEARCH ENGINE
------------------------------------------------------- */

async function researchIdea(env, idea) {
  const prompt = `
You are the product research assistant for Shopper's Suggestions.

Research idea:
${clean(idea, 2000)}

We need a product opportunity that could reasonably fit
an affiliate shopping recommendation website.

Do NOT invent current sales numbers, prices, reviews,
or trend statistics.

Return:
{
  "product_idea": "",
  "problem_solved": "",
  "target_customer": "",
  "category": "",
  "why_people_might_want_it": "",
  "research_notes": [],
  "search_terms": []
}
`;

  return await askAIJSON(env, prompt, {
    product_idea: idea,
    problem_solved: "",
    target_customer: "",
    category: "Other",
    why_people_might_want_it: "",
    research_notes: [],
    search_terms: []
  });
}

/* -------------------------------------------------------
   DRAFT CREATION
------------------------------------------------------- */

async function createDraft(env, data) {
  const title = clean(data.title);
  const description = clean(data.description);
  const affiliateUrl = clean(data.affiliate_url);

  if (!title) {
    throw new Error("Product title is required.");
  }

  const category = CATEGORIES.includes(data.category)
    ? data.category
    : "Other";

  const marketing = await askAIJSON(
    env,
    `
Create marketing copy for this product.

Title:
${title}

Description:
${description}

Category:
${category}

Return:
{
  "instagram_caption": "",
  "short_caption": "",
  "hashtags": [],
  "call_to_action": ""
}
`,
    {
      instagram_caption: "",
      short_caption: "",
      hashtags: [],
      call_to_action: "MAKE IT YOURS!"
    }
  );

  const result = await env.DB.prepare(`
    INSERT INTO manager_drafts (
      title,
      description,
      affiliate_url,
      category,
      image1_url,
      image2_url,
      image3_url,
      image4_url,
      image5_url,
      video_url,
      marketing_json,
      source_json,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `)
    .bind(
      title,
      description,
      affiliateUrl,
      category,
      clean(data.image1_url),
      clean(data.image2_url),
      clean(data.image3_url),
      clean(data.image4_url),
      clean(data.image5_url),
      clean(data.video_url),
      JSON.stringify(marketing),
      JSON.stringify(data.source || {})
    )
    .run();

  await log(
    env,
    "info",
    "draft_created",
    `Draft ${result.meta.last_row_id} created.`
  );

  return {
    id: result.meta.last_row_id,
    marketing
  };
}

/* -------------------------------------------------------
   PUBLISH DRAFT
------------------------------------------------------- */

async function publishDraft(env, id) {
  const draft = await env.DB.prepare(`
    SELECT *
    FROM manager_drafts
    WHERE id = ?
    LIMIT 1
  `)
    .bind(id)
    .first();

  if (!draft) {
    throw new Error("Draft not found.");
  }

  if (!draft.affiliate_url) {
    throw new Error("Draft has no affiliate URL.");
  }

  const result = await env.DB.prepare(`
    INSERT INTO products (
      title,
      description,
      affiliate_url,
      category,
      image1_url,
      image2_url,
      image3_url,
      image4_url,
      image5_url,
      video_url,
      published,
      featured
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
  `)
    .bind(
      draft.title,
      draft.description,
      draft.affiliate_url,
      draft.category,
      draft.image1_url,
      draft.image2_url,
      draft.image3_url,
      draft.image4_url,
      draft.image5_url,
      draft.video_url
    )
    .run();

  await env.DB.prepare(`
    UPDATE manager_drafts
    SET status = 'published',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
    .bind(id)
    .run();

  await log(
    env,
    "info",
    "product_published",
    `Draft ${id} published as product ${result.meta.last_row_id}.`
  );

  return {
    product_id: result.meta.last_row_id
  };
}

/* -------------------------------------------------------
   MARKETING
------------------------------------------------------- */

async function createMarketing(env, product) {
  return await askAIJSON(
    env,
    `
Create a marketing package for this product.

Title:
${product.title}

Description:
${product.description}

Category:
${product.category}

Rules:
- Do not invent facts.
- Do not claim a product is trending unless evidence is supplied.
- Do not fabricate discounts or prices.
- Keep the copy suitable for a general shopping audience.

Return:
{
  "instagram_caption": "",
  "short_caption": "",
  "hashtags": [],
  "hook": "",
  "cta": "MAKE IT YOURS!",
  "content_ideas": []
}
`,
    {
      instagram_caption: "",
      short_caption: "",
      hashtags: [],
      hook: "",
      cta: "MAKE IT YOURS!",
      content_ideas: []
    }
  );
}

/* -------------------------------------------------------
   INTEGRATION STATUS
------------------------------------------------------- */

function integrations(env) {
  return {
    workers_ai: !!env.AI,
    website: true,
    d1: !!env.DB,

    github_media:
      !!env.GITHUB_TOKEN &&
      !!env.GITHUB_OWNER &&
      !!env.GITHUB_REPO,

    telegram:
      !!env.TELEGRAM_BOT_TOKEN,

    instagram:
      !!env.INSTAGRAM_ACCESS_TOKEN &&
      !!env.INSTAGRAM_BUSINESS_ACCOUNT_ID,

    affiliate:
      !!env.AFFILIATE_API_URL &&
      !!env.AFFILIATE_API_KEY,

    browser_automation:
      !!env.BROWSER_API_URL &&
      !!env.BROWSER_API_KEY
  };
}

/* -------------------------------------------------------
   TASKS
------------------------------------------------------- */

async function createTask(env, type, input = {}) {
  const result = await env.DB.prepare(`
    INSERT INTO manager_tasks
    (type, status, input_json)
    VALUES (?, 'pending', ?)
  `)
    .bind(type, JSON.stringify(input))
    .run();

  return result.meta.last_row_id;
}

async function updateTask(
  env,
  id,
  status,
  output = {},
  error = ""
) {
  await env.DB.prepare(`
    UPDATE manager_tasks
    SET status = ?,
        output_json = ?,
        error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
    .bind(
      status,
      JSON.stringify(output),
      clean(error, 4000),
      id
    )
    .run();
}

async function runTask(env, id) {
  const task = await env.DB.prepare(`
    SELECT *
    FROM manager_tasks
    WHERE id = ?
    LIMIT 1
  `)
    .bind(id)
    .first();

  if (!task) {
    throw new Error("Task not found.");
  }

  const input = JSON.parse(task.input_json || "{}");

  await updateTask(env, id, "running");

  try {
    let output;

    switch (task.type) {
      case "research":
        output = await researchIdea(
          env,
          input.idea || ""
        );
        break;

      case "marketing":
        const product = await getProduct(
          env,
          Number(input.product_id)
        );

        if (!product) {
          throw new Error("Product not found.");
        }

        output = await createMarketing(
          env,
          product
        );
        break;

      case "classify":
        const classifyProductData = await getProduct(
          env,
          Number(input.product_id)
        );

        if (!classifyProductData) {
          throw new Error("Product not found.");
        }

        output = await classifyProduct(
          env,
          classifyProductData
        );
        break;

      case "improve":
        const improveProductData = await getProduct(
          env,
          Number(input.product_id)
        );

        if (!improveProductData) {
          throw new Error("Product not found.");
        }

        output = await improveProduct(
          env,
          improveProductData
        );
        break;

      default:
        throw new Error(
          `Unknown task type: ${task.type}`
        );
    }

    await updateTask(
      env,
      id,
      "completed",
      output
    );

    return output;
  } catch (error) {
    await updateTask(
      env,
      id,
      "failed",
      {},
      error.message
    );

    throw error;
  }
}

/* -------------------------------------------------------
   DASHBOARD API
------------------------------------------------------- */

async function dashboard(env) {
  const products = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM products
  `).first();

  const published = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM products
    WHERE published = 1
  `).first();

  const featured = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM products
    WHERE featured = 1
  `).first();

  const drafts = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM manager_drafts
    WHERE status = 'draft'
  `).first();

  const pendingTasks = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM manager_tasks
    WHERE status = 'pending'
  `).first();

  const recentLogs = await env.DB.prepare(`
    SELECT *
    FROM manager_logs
    ORDER BY created_at DESC
    LIMIT 20
  `).all();

  return {
    manager: "online",
    products: Number(products?.count || 0),
    published: Number(published?.count || 0),
    featured: Number(featured?.count || 0),
    drafts: Number(drafts?.count || 0),
    pending_tasks: Number(pendingTasks?.count || 0),
    integrations: integrations(env),
    categories: CATEGORIES,
    recent_logs: recentLogs.results || []
  };
}

/* -------------------------------------------------------
   COMMAND ROUTER
------------------------------------------------------- */

async function handle(request, env) {
  if (!requireManagerSecret(request, env)) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  await ensureManagerTables(env);

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/") {
    return json({
      ok: true,
      manager: "shopper-ai-manager",
      status: "online",
      message: "AI Manager backend is running.",
      dashboard: "/api/dashboard"
    });
  }

  if (method === "GET" && path === "/api/health") {
    return json({
      ok: true,
      manager: "online",
      database: !!env.DB,
      ai: !!env.AI,
      integrations: integrations(env)
    });
  }

  if (
    method === "GET" &&
    path === "/api/dashboard"
  ) {
    return json({
      ok: true,
      ...(await dashboard(env))
    });
  }

  if (
    method === "GET" &&
    path === "/api/products"
  ) {
    const limit =
      Number(url.searchParams.get("limit")) || 50;

    return json({
      ok: true,
      products: await getProducts(env, limit)
    });
  }

  if (
    method === "GET" &&
    path.startsWith("/api/products/")
  ) {
    const id = Number(
      path.split("/").pop()
    );

    const product = await getProduct(env, id);

    if (!product) {
      return json({
        ok: false,
        error: "Product not found."
      }, 404);
    }

    return json({
      ok: true,
      product
    });
  }

  /* AI CHAT */

  if (
    method === "POST" &&
    path === "/api/ai/chat"
  ) {
    const body = await readJSON(request);

    const message = clean(
      body.message,
      5000
    );

    if (!message) {
      return json({
        ok: false,
        error: "Message is required."
      }, 400);
    }

    const productContext =
      await getProducts(env, 20);

    const prompt = `
You are the Manager AI for Shopper's Suggestions.

You help the owner operate an affiliate shopping website.

Current product database:
${JSON.stringify(productContext, null, 2)}

Available categories:
${CATEGORIES.join(", ")}

User request:
${message}

You can explain what should happen and produce structured
recommendations.

Never claim an external action happened unless this Worker
actually performed it.

Be concise and practical.
`;

    const answer = await askAI(
      env,
      prompt,
      {
        max_tokens: 1500
      }
    );

    await log(
      env,
      "info",
      "ai_chat",
      "Manager AI chat request completed."
    );

    return json({
      ok: true,
      answer
    });
  }

  /* RESEARCH */

  if (
    method === "POST" &&
    path === "/api/research"
  ) {
    const body = await readJSON(request);

    const taskId = await createTask(
      env,
      "research",
      {
        idea: clean(body.idea, 3000)
      }
    );

    const result = await runTask(
      env,
      taskId
    );

    return json({
      ok: true,
      task_id: taskId,
      result
    });
  }

  /* CLASSIFICATION */

  if (
    method === "POST" &&
    path === "/api/products/classify"
  ) {
    const body = await readJSON(request);

    const taskId = await createTask(
      env,
      "classify",
      {
        product_id: Number(
          body.product_id
        )
      }
    );

    const result = await runTask(
      env,
      taskId
    );

    return json({
      ok: true,
      task_id: taskId,
      result
    });
  }

  /* CONTENT IMPROVEMENT */

  if (
    method === "POST" &&
    path === "/api/products/improve"
  ) {
    const body = await readJSON(request);

    const taskId = await createTask(
      env,
      "improve",
      {
        product_id: Number(
          body.product_id
        )
      }
    );

    const result = await runTask(
      env,
      taskId
    );

    return json({
      ok: true,
      task_id: taskId,
      result
    });
  }

  /* MARKETING */

  if (
    method === "POST" &&
    path === "/api/marketing"
  ) {
    const body = await readJSON(request);

    const taskId = await createTask(
      env,
      "marketing",
      {
        product_id: Number(
          body.product_id
        )
      }
    );

    const result = await runTask(
      env,
      taskId
    );

    return json({
      ok: true,
      task_id: taskId,
      result
    });
  }

  /* CREATE DRAFT */

  if (
    method === "POST" &&
    path === "/api/drafts"
  ) {
    const body = await readJSON(request);

    const draft = await createDraft(
      env,
      body
    );

    return json({
      ok: true,
      draft
    });
  }

  /* LIST DRAFTS */

  if (
    method === "GET" &&
    path === "/api/drafts"
  ) {
    const result = await env.DB.prepare(`
      SELECT *
      FROM manager_drafts
      ORDER BY created_at DESC
      LIMIT 100
    `).all();

    return json({
      ok: true,
      drafts: result.results || []
    });
  }

  /* PUBLISH DRAFT */

  if (
    method === "POST" &&
    path.startsWith("/api/drafts/") &&
    path.endsWith("/publish")
  ) {
    const pieces = path.split("/");
    const id = Number(pieces[3]);

    /*
      IMPORTANT:
      This endpoint is intentionally protected by the
      manager secret when one is configured.

      The dashboard should eventually put a human approval
      button here before automatic public publishing.
    */

    const result = await publishDraft(
      env,
      id
    );

    return json({
      ok: true,
      published: result
    });
  }

  /* TASK LIST */

  if (
    method === "GET" &&
    path === "/api/tasks"
  ) {
    const result = await env.DB.prepare(`
      SELECT *
      FROM manager_tasks
      ORDER BY created_at DESC
      LIMIT 100
    `).all();

    return json({
      ok: true,
      tasks: result.results || []
    });
  }

  /* LOGS */

  if (
    method === "GET" &&
    path === "/api/logs"
  ) {
    const result = await env.DB.prepare(`
      SELECT *
      FROM manager_logs
      ORDER BY created_at DESC
      LIMIT 100
    `).all();

    return json({
      ok: true,
      logs: result.results || []
    });
  }

  /* INTEGRATIONS */

  if (
    method === "GET" &&
    path === "/api/integrations"
  ) {
    return json({
      ok: true,
      integrations: integrations(env)
    });
  }

  /* CATEGORIES */

  if (
    method === "GET" &&
    path === "/api/categories"
  ) {
    return json({
      ok: true,
      categories: CATEGORIES
    });
  }

  /* FUTURE GITHUB MEDIA CONNECTION */

  if (
    method === "POST" &&
    path === "/api/integrations/github/test"
  ) {
    if (!env.GITHUB_TOKEN) {
      return json({
        ok: false,
        connected: false,
        error: "GITHUB_TOKEN is not configured."
      }, 400);
    }

    return json({
      ok: true,
      connected: true,
      message:
        "GitHub credentials are present. Media operations can be connected next."
    });
  }

  /* FUTURE INSTAGRAM CONNECTION */

  if (
    method === "POST" &&
    path === "/api/integrations/instagram/test"
  ) {
    if (
      !env.INSTAGRAM_ACCESS_TOKEN ||
      !env.INSTAGRAM_BUSINESS_ACCOUNT_ID
    ) {
      return json({
        ok: false,
        connected: false,
        error:
          "Instagram credentials are not configured."
      }, 400);
    }

    return json({
      ok: true,
      connected: true,
      message:
        "Instagram credentials are present. Publishing can be connected next."
    });
  }

  /* FUTURE AFFILIATE CONNECTION */

  if (
    method === "POST" &&
    path === "/api/integrations/affiliate/test"
  ) {
    if (
      !env.AFFILIATE_API_URL ||
      !env.AFFILIATE_API_KEY
    ) {
      return json({
        ok: false,
        connected: false,
        error:
          "Affiliate integration credentials are not configured."
      }, 400);
    }

    return json({
      ok: true,
      connected: true
    });
  }

  return json({
    ok: false,
    error: "Route not found."
  }, 404);
}

/* -------------------------------------------------------
   SCHEDULED AUTOMATION
------------------------------------------------------- */

async function scheduledRun(env) {
  await ensureManagerTables(env);

  await log(
    env,
    "info",
    "scheduled_run",
    "Scheduled Manager run started."
  );

  /*
    This is intentionally conservative.

    Later this scheduler can:
      1. discover products
      2. research them
      3. generate content
      4. obtain permitted media
      5. create drafts
      6. request approval
      7. publish approved items
      8. create marketing content
      9. publish through authorized APIs
      10. record analytics
  */

  return {
    ok: true,
    status: "scheduled_run_completed",
    timestamp: new Date().toISOString()
  };
}

/* -------------------------------------------------------
   WORKER ENTRYPOINT
------------------------------------------------------- */

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return withCors(
        new Response(null, {
          status: 204,
          headers: corsHeaders()
        })
      );
    }

    try {
      const response =
        await handle(request, env);

      return withCors(response);
    } catch (error) {
      console.error(error);

      await log(
        env,
        "error",
        "request_error",
        error.message
      );

      return withCors(
        json({
          ok: false,
          error: error.message || "Internal error."
        }, 500)
      );
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      scheduledRun(env)
    );
  }
};
