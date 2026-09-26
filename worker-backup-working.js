const MODEL = "@cf/google/gemma-4-26b-a4b-it";

const CHAT_SESSION_ID = "main";
const MAX_HISTORY = 30;
const CHAT_RETENTION_HOURS = 24;

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

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (method === "OPTIONS") {
        return new Response(null, {
          headers: corsHeaders()
        });
      }

      await ensureTables(env);

      /*
       * FRONTEND
       */
      if (path === "/" && method === "GET") {
        return new Response(managerPage(), {
          headers: {
            "content-type": "text/html;charset=UTF-8"
          }
        });
      }

      /*
       * HEALTH
       */
      if (path === "/api/health" && method === "GET") {
        return json({
          ok: true,
          manager: "shopper-ai-manager",
          ai: !!env.AI,
          database: !!env.DB,
          assets: !!env.ASSETS,
          model: MODEL
        });
      }

      /*
       * DASHBOARD
       */
      if (path === "/api/dashboard" && method === "GET") {
        return await dashboard(env);
      }

      /*
       * PRODUCTS
       */
      if (path === "/api/products" && method === "GET") {
        return await getProducts(env);
      }

      const productMatch = path.match(/^\/api\/products\/(\d+)$/);

      if (productMatch && method === "GET") {
        return await getProduct(env, Number(productMatch[1]));
      }

      /*
       * AI CHAT
       */
      if (path === "/api/ai/chat" && method === "POST") {
        return await aiChat(request, env);
      }

      if (path === "/api/ai/chat/reset" && method === "POST") {
        return await resetChat(env);
      }

      /*
       * RESEARCH
       */
      if (path === "/api/research" && method === "POST") {
        return await research(request, env);
      }

      /*
       * PRODUCT CLASSIFICATION
       */
      if (path === "/api/products/classify" && method === "POST") {
        return await classifyProduct(request, env);
      }

      /*
       * PRODUCT IMPROVEMENT
       */
      if (path === "/api/products/improve" && method === "POST") {
        return await improveProduct(request, env);
      }

      /*
       * MARKETING
       */
      if (path === "/api/marketing" && method === "POST") {
        return await marketing(request, env);
      }

      /*
       * DRAFTS
       */
      if (path === "/api/drafts" && method === "GET") {
        return await getDrafts(env);
      }

      if (path === "/api/drafts" && method === "POST") {
        return await createDraft(request, env);
      }

      const draftPublishMatch =
        path.match(/^\/api\/drafts\/(\d+)\/publish$/);

      if (draftPublishMatch && method === "POST") {
        return await publishDraft(
          request,
          env,
          Number(draftPublishMatch[1])
        );
      }

      /*
       * TASKS
       */
      if (path === "/api/tasks" && method === "GET") {
        return await getTasks(env);
      }

      if (path === "/api/tasks" && method === "POST") {
        return await createTask(request, env);
      }

      /*
       * LOGS
       */
      if (path === "/api/logs" && method === "GET") {
        return await getLogs(env);
      }

      /*
       * INTEGRATIONS
       */
      if (path === "/api/integrations" && method === "GET") {
        return await integrations(env);
      }

      if (
        path === "/api/integrations/github/test" &&
        method === "GET"
      ) {
        return await testGitHub(env);
      }

      if (
        path === "/api/integrations/instagram/test" &&
        method === "GET"
      ) {
        return json({
          ok: false,
          connected: false,
          service: "instagram",
          message:
            "Instagram publishing requires an authorized Instagram/Meta integration."
        });
      }

      if (
        path === "/api/integrations/affiliate/test" &&
        method === "GET"
      ) {
        return json({
          ok: false,
          connected: false,
          service: "affiliate",
          message:
            "Affiliate publishing requires the affiliate platform credentials/API connection."
        });
      }

      /*
       * CATEGORIES
       */
      if (path === "/api/categories" && method === "GET") {
        return json({
          ok: true,
          categories: CATEGORIES
        });
      }

      return json(
        {
          ok: false,
          error: "Route not found"
        },
        404
      );
    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error: error?.message || String(error)
        },
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledManager(env));
  }
};

/* =========================================================
   RESPONSE HELPERS
========================================================= */

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "content-type": "application/json;charset=UTF-8"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders()
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function safeString(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value).trim();
}

/* =========================================================
   DATABASE SETUP
========================================================= */

async function ensureTables(env) {
  if (!env.DB) {
    throw new Error("D1 database binding DB is missing.");
  }

  /*
   * IMPORTANT:
   *
   * manager_chat_messages already exists in the user's database.
   * We DO NOT recreate or modify that table.
   *
   * Its exact schema is:
   *
   * id
   * session_id
   * role
   * content
   * created_at
   * expires_at
   *
   * created_at and expires_at are both NOT NULL.
   */

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
    `)
  ]);
}

/* =========================================================
   CLEAN EXPIRED CHAT
========================================================= */

async function cleanExpiredChat(env) {
  await env.DB
    .prepare(`
      DELETE FROM manager_chat_messages
      WHERE expires_at <= datetime('now')
    `)
    .run();
}

/* =========================================================
   AI CHAT
========================================================= */

async function aiChat(request, env) {
  if (!env.AI) {
    return json(
      {
        ok: false,
        error: "Workers AI binding AI is missing."
      },
      500
    );
  }

  const body = await readJson(request);

  const message = safeString(
    body.message || body.prompt || body.content
  );

  if (!message) {
    return json(
      {
        ok: false,
        error: "Message is required."
      },
      400
    );
  }

  await cleanExpiredChat(env);

  /*
   * Get recent conversation.
   */
  const historyResult = await env.DB
    .prepare(`
      SELECT role, content
      FROM manager_chat_messages
      WHERE session_id = ?
        AND expires_at > datetime('now')
      ORDER BY id DESC
      LIMIT ?
    `)
    .bind(CHAT_SESSION_ID, MAX_HISTORY)
    .all();

  const history = (historyResult.results || [])
    .reverse()
    .map(row => ({
      role: row.role,
      content: row.content
    }));

  /*
   * IMPORTANT FIX:
   *
   * Both created_at AND expires_at are explicitly inserted.
   */
  await env.DB
    .prepare(`
      INSERT INTO manager_chat_messages
      (
        session_id,
        role,
        content,
        created_at,
        expires_at
      )
      VALUES (
        ?,
        ?,
        ?,
        datetime('now'),
        datetime('now', '+24 hours')
      )
    `)
    .bind(
      CHAT_SESSION_ID,
      "user",
      message
    )
    .run();

  const systemPrompt = `
You are the AI Manager for Shopper's Suggestions.

Website:
https://shopperssuggestions.online

Your job is to help operate and grow an affiliate-product discovery website.

You can help with:
- finding product opportunities
- product research
- product titles
- product descriptions
- category selection
- affiliate product ideas
- product marketing
- Instagram content ideas
- product listing improvements
- website strategy
- trend analysis
- campaign ideas
- workflow planning

Important rules:
- Be practical.
- Do not pretend an external service is connected when it is not.
- Do not invent affiliate links.
- Do not claim that a product was published unless the system actually published it.
- Clearly distinguish research from verified facts.
- Keep answers useful and direct.
- You are an assistant/manager, not a human employee.
`;

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    ...history,
    {
      role: "user",
      content: message
    }
  ];

  let answer = "";

  try {
    const result = await env.AI.run(MODEL, {
      messages,
      max_tokens: 1200,
      temperature: 0.7
    });

    answer =
      result?.response ||
      result?.text ||
      result?.output_text ||
      "";

    if (!answer && result?.choices?.[0]?.message?.content) {
      answer = result.choices[0].message.content;
    }

    if (!answer) {
      answer = JSON.stringify(result);
    }
  } catch (error) {
    console.error("AI error:", error);

    return json(
      {
        ok: false,
        error: "AI request failed.",
        details: error?.message || String(error)
      },
      500
    );
  }

  /*
   * IMPORTANT FIX:
   *
   * Assistant message also receives both timestamps.
   */
  await env.DB
    .prepare(`
      INSERT INTO manager_chat_messages
      (
        session_id,
        role,
        content,
        created_at,
        expires_at
      )
      VALUES (
        ?,
        ?,
        ?,
        datetime('now'),
        datetime('now', '+24 hours')
      )
    `)
    .bind(
      CHAT_SESSION_ID,
      "assistant",
      answer
    )
    .run();

  await addLog(
    env,
    "info",
    "AI chat completed",
    {
      session_id: CHAT_SESSION_ID
    }
  );

  return json({
    ok: true,
    answer,
    model: MODEL,
    session_id: CHAT_SESSION_ID,
    retention_hours: CHAT_RETENTION_HOURS
  });
}

/* =========================================================
   RESET CHAT
========================================================= */

async function resetChat(env) {
  await env.DB
    .prepare(`
      DELETE FROM manager_chat_messages
      WHERE session_id = ?
    `)
    .bind(CHAT_SESSION_ID)
    .run();

  await addLog(
    env,
    "info",
    "AI chat reset",
    {}
  );

  return json({
    ok: true,
    reset: true
  });
}

/* =========================================================
   DASHBOARD
========================================================= */

async function dashboard(env) {
  const [
    products,
    published,
    drafts,
    tasks,
    logs
  ] = await Promise.all([
    env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM products
      `)
      .first(),

    env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM products
        WHERE published = 1
      `)
      .first(),

    env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM manager_drafts
        WHERE status = 'draft'
      `)
      .first(),

    env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM manager_tasks
        WHERE status IN ('pending','running')
      `)
      .first(),

    env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM manager_logs
      `)
      .first()
  ]);

  return json({
    ok: true,
    products: Number(products?.count || 0),
    published_products: Number(published?.count || 0),
    drafts: Number(drafts?.count || 0),
    active_tasks: Number(tasks?.count || 0),
    logs: Number(logs?.count || 0),
    ai: !!env.AI,
    database: !!env.DB
  });
}

/* =========================================================
   PRODUCTS
========================================================= */

async function getProducts(env) {
  const result = await env.DB
    .prepare(`
      SELECT *
      FROM products
      WHERE published = 1
      ORDER BY created_at DESC
      LIMIT 200
    `)
    .all();

  return json({
    ok: true,
    products: result.results || []
  });
}

async function getProduct(env, id) {
  const product = await env.DB
    .prepare(`
      SELECT *
      FROM products
      WHERE id = ?
      LIMIT 1
    `)
    .bind(id)
    .first();

  if (!product) {
    return json(
      {
        ok: false,
        error: "Product not found."
      },
      404
    );
  }

  return json({
    ok: true,
    product
  });
}

/* =========================================================
   AI RESEARCH
========================================================= */

async function research(request, env) {
  const body = await readJson(request);

  const query = safeString(
    body.query ||
    body.product ||
    body.topic
  );

  if (!query) {
    return json(
      {
        ok: false,
        error: "Research query is required."
      },
      400
    );
  }

  const prompt = `
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
`;

  const answer = await runAI(env, prompt);

  await addLog(
    env,
    "info",
    "Product research completed",
    { query }
  );

  return json({
    ok: true,
    query,
    result: answer
  });
}

/* =========================================================
   CLASSIFY PRODUCT
========================================================= */

async function classifyProduct(request, env) {
  const body = await readJson(request);

  const title = safeString(body.title);
  const description = safeString(body.description);

  if (!title && !description) {
    return json(
      {
        ok: false,
        error: "Product title or description is required."
      },
      400
    );
  }

  const prompt = `
Classify this product for Shopper's Suggestions.

Title:
${title}

Description:
${description}

Available categories:
${CATEGORIES.join(", ")}

Return JSON only:

{
  "category": "...",
  "reason": "...",
  "keywords": ["...", "...", "..."]
}
`;

  const answer = await runAI(env, prompt);

  return json({
    ok: true,
    result: answer
  });
}

/* =========================================================
   IMPROVE PRODUCT
========================================================= */

async function improveProduct(request, env) {
  const body = await readJson(request);

  const title = safeString(body.title);
  const description = safeString(body.description);
  const category = safeString(body.category);

  const prompt = `
Improve this affiliate product listing.

Title:
${title}

Description:
${description}

Category:
${category}

Create:

1. Better title
2. Clear product description
3. Short selling points
4. Call-to-action
5. Search keywords

Do not invent technical specifications that were not supplied.
`;

  const answer = await runAI(env, prompt);

  return json({
    ok: true,
    result: answer
  });
}

/* =========================================================
   MARKETING
========================================================= */

async function marketing(request, env) {
  const body = await readJson(request);

  const title = safeString(body.title);
  const description = safeString(body.description);
  const platform = safeString(
    body.platform,
    "Instagram"
  );

  if (!title && !description) {
    return json(
      {
        ok: false,
        error: "Product information is required."
      },
      400
    );
  }

  const prompt = `
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
`;

  const answer = await runAI(env, prompt);

  await addLog(
    env,
    "info",
    "Marketing content generated",
    {
      product: title,
      platform
    }
  );

  return json({
    ok: true,
    result: answer
  });
}

/* =========================================================
   DRAFTS
========================================================= */

async function getDrafts(env) {
  const result = await env.DB
    .prepare(`
      SELECT *
      FROM manager_drafts
      ORDER BY id DESC
      LIMIT 100
    `)
    .all();

  return json({
    ok: true,
    drafts: result.results || []
  });
}

async function createDraft(request, env) {
  const body = await readJson(request);

  const now = new Date().toISOString();

  const title = safeString(body.title);
  const description = safeString(body.description);
  const affiliateUrl = safeString(
    body.affiliate_url || body.affiliateUrl
  );
  const category = safeString(
    body.category,
    "Other"
  );
  const videoUrl = safeString(
    body.video_url || body.videoUrl
  );

  const imageUrls = Array.isArray(body.image_urls)
    ? body.image_urls
    : Array.isArray(body.images)
      ? body.images
      : [];

  const result = await env.DB
    .prepare(`
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
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `)
    .bind(
      title,
      description,
      affiliateUrl,
      category,
      JSON.stringify(imageUrls),
      videoUrl,
      now,
      now
    )
    .run();

  await addLog(
    env,
    "info",
    "Draft created",
    {
      id: result.meta?.last_row_id
    }
  );

  return json({
    ok: true,
    id: result.meta?.last_row_id
  });
}

/* =========================================================
   PUBLISH DRAFT
========================================================= */

async function publishDraft(request, env, id) {
  const draft = await env.DB
    .prepare(`
      SELECT *
      FROM manager_drafts
      WHERE id = ?
      LIMIT 1
    `)
    .bind(id)
    .first();

  if (!draft) {
    return json(
      {
        ok: false,
        error: "Draft not found."
      },
      404
    );
  }

  let images = [];

  try {
    images = JSON.parse(draft.image_urls || "[]");
  } catch {
    images = [];
  }

  while (images.length < 5) {
    images.push("");
  }

  const now = new Date().toISOString();

  const result = await env.DB
    .prepare(`
      INSERT INTO products
      (
        title,
        description,
        affiliate_url,
        category,
        image1_url,
        image2_url,
        image3_url,
        image4_url,
        image5_url,
        published,
        created_at,
        updated_at,
        video_url,
        featured
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)
    `)
    .bind(
      draft.title,
      draft.description,
      draft.affiliate_url,
      draft.category,
      images[0] || "",
      images[1] || "",
      images[2] || "",
      images[3] || "",
      images[4] || "",
      now,
      now,
      draft.video_url || ""
    )
    .run();

  await env.DB
    .prepare(`
      UPDATE manager_drafts
      SET status = 'published',
          updated_at = ?
      WHERE id = ?
    `)
    .bind(now, id)
    .run();

  await addLog(
    env,
    "info",
    "Draft published",
    {
      draft_id: id,
      product_id: result.meta?.last_row_id
    }
  );

  return json({
    ok: true,
    published: true,
    product_id: result.meta?.last_row_id
  });
}

/* =========================================================
   TASKS
========================================================= */

async function getTasks(env) {
  const result = await env.DB
    .prepare(`
      SELECT *
      FROM manager_tasks
      ORDER BY id DESC
      LIMIT 100
    `)
    .all();

  return json({
    ok: true,
    tasks: result.results || []
  });
}

async function createTask(request, env) {
  const body = await readJson(request);

  const now = new Date().toISOString();

  const type = safeString(
    body.type,
    "general"
  );

  const data = body.data || body;

  const result = await env.DB
    .prepare(`
      INSERT INTO manager_tasks
      (
        type,
        status,
        data_json,
        result_json,
        created_at,
        updated_at
      )
      VALUES (?, 'pending', ?, '{}', ?, ?)
    `)
    .bind(
      type,
      JSON.stringify(data),
      now,
      now
    )
    .run();

  return json({
    ok: true,
    id: result.meta?.last_row_id
  });
}

/* =========================================================
   LOGS
========================================================= */

async function getLogs(env) {
  const result = await env.DB
    .prepare(`
      SELECT *
      FROM manager_logs
      ORDER BY id DESC
      LIMIT 100
    `)
    .all();

  return json({
    ok: true,
    logs: result.results || []
  });
}

async function addLog(
  env,
  level,
  message,
  data = {}
) {
  try {
    await env.DB
      .prepare(`
        INSERT INTO manager_logs
        (
          level,
          message,
          data_json,
          created_at
        )
        VALUES (?, ?, ?, ?)
      `)
      .bind(
        level,
        message,
        JSON.stringify(data),
        new Date().toISOString()
      )
      .run();
  } catch (error) {
    console.error("Logging failed:", error);
  }
}

/* =========================================================
   INTEGRATIONS
========================================================= */

async function integrations(env) {
  return json({
    ok: true,

    website: {
      connected: !!env.WEBSITE_URL,
      url: env.WEBSITE_URL || ""
    },

    github: {
      configured:
        !!env.GITHUB_OWNER &&
        !!env.GITHUB_REPO &&
        !!env.GITHUB_BRANCH
    },

    instagram: {
      connected: false,
      message:
        "Requires authorized Meta/Instagram integration."
    },

    affiliate: {
      connected: false,
      message:
        "Requires authorized affiliate-platform integration."
    },

    ai: {
      connected: !!env.AI,
      model: MODEL
    },

    database: {
      connected: !!env.DB
    }
  });
}

/* =========================================================
   GITHUB TEST
========================================================= */

async function testGitHub(env) {
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) {
    return json({
      ok: false,
      connected: false,
      message:
        "GITHUB_OWNER or GITHUB_REPO is missing."
    });
  }

  if (!env.GITHUB_TOKEN) {
    return json({
      ok: false,
      connected: false,
      message:
        "GITHUB_TOKEN secret is missing."
    });
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(
      env.GITHUB_OWNER
    )}/${encodeURIComponent(env.GITHUB_REPO)}`,
    {
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "shopper-ai-manager"
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    return json({
      ok: false,
      connected: false,
      status: response.status,
      error: data?.message || "GitHub request failed."
    });
  }

  return json({
    ok: true,
    connected: true,
    repository: data.full_name,
    private: data.private,
    default_branch: data.default_branch
  });
}

/* =========================================================
   AI HELPER
========================================================= */

async function runAI(env, prompt) {
  if (!env.AI) {
    throw new Error(
      "Workers AI binding AI is missing."
    );
  }

  const result = await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You are a practical AI manager for Shopper's Suggestions. Do not invent facts or claim actions that were not performed."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    max_tokens: 1400,
    temperature: 0.7
  });

  return (
    result?.response ||
    result?.text ||
    result?.output_text ||
    result?.choices?.[0]?.message?.content ||
    JSON.stringify(result)
  );
}

/* =========================================================
   SCHEDULED MANAGER
========================================================= */

async function runScheduledManager(env) {
  try {
    /*
     * Remove expired AI chat automatically.
     */
    await cleanExpiredChat(env);

    /*
     * Mark old running tasks as pending again if needed.
     * This prevents a task from becoming permanently stuck.
     */
    await env.DB
      .prepare(`
        UPDATE manager_tasks
        SET status = 'pending',
            updated_at = ?
        WHERE status = 'running'
          AND updated_at < datetime('now', '-2 hours')
      `)
      .bind(new Date().toISOString())
      .run();

    await addLog(
      env,
      "info",
      "Scheduled manager cycle completed",
      {}
    );
  } catch (error) {
    console.error(
      "Scheduled manager error:",
      error
    );

    await addLog(
      env,
      "error",
      "Scheduled manager failed",
      {
        error: error?.message || String(error)
      }
    );
  }
}

/* =========================================================
   MANAGER WEB INTERFACE
========================================================= */

function managerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Shopper's Suggestions AI Manager</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  background:
    radial-gradient(
      circle at top left,
      rgba(255,126,0,.18),
      transparent 30%
    ),
    radial-gradient(
      circle at bottom right,
      rgba(0,78,160,.18),
      transparent 30%
    ),
    #f5f7fa;
  color: #10131a;
}

header {
  position: sticky;
  top: 0;
  z-index: 10;
  backdrop-filter: blur(20px);
  background: rgba(255,255,255,.82);
  border-bottom: 1px solid #e5e7eb;
  padding: 18px 20px;
}

.header-inner {
  max-width: 1200px;
  margin: auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
}

.brand {
  font-weight: 800;
  font-size: 19px;
}

.status {
  font-size: 12px;
  color: #15803d;
}

main {
  max-width: 1200px;
  margin: auto;
  padding: 25px 16px 60px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit,minmax(280px,1fr));
  gap: 16px;
}

.card {
  background: rgba(255,255,255,.9);
  border: 1px solid #e5e7eb;
  border-radius: 22px;
  padding: 20px;
  box-shadow:
    0 12px 40px rgba(0,0,0,.06);
}

h2 {
  margin-top: 0;
}

textarea,
input,
select {
  width: 100%;
  border: 1px solid #d7dbe2;
  border-radius: 14px;
  padding: 13px;
  font: inherit;
  outline: none;
  margin-top: 8px;
}

textarea {
  min-height: 130px;
  resize: vertical;
}

button {
  border: 0;
  border-radius: 14px;
  padding: 12px 16px;
  font-weight: 700;
  cursor: pointer;
  background: #111827;
  color: white;
  margin-top: 10px;
}

button.secondary {
  background: #edf0f4;
  color: #111827;
}

.chat {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 520px;
  overflow: auto;
  margin-bottom: 12px;
}

.msg {
  padding: 12px 14px;
  border-radius: 16px;
  max-width: 90%;
  white-space: pre-wrap;
  line-height: 1.5;
}

.user {
  align-self: flex-end;
  background: #111827;
  color: white;
}

.assistant {
  align-self: flex-start;
  background: #f0f2f5;
}

.stat {
  font-size: 30px;
  font-weight: 800;
}

.small {
  font-size: 12px;
  color: #68707d;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
</head>

<body>

<header>
  <div class="header-inner">
    <div class="brand">
      Shopper's Suggestions · AI Manager
    </div>
    <div class="status">
      ● Manager Online
    </div>
  </div>
</header>

<main>

  <div class="grid">

    <section class="card">
      <h2>Dashboard</h2>

      <div class="grid">

        <div>
          <div class="small">Products</div>
          <div id="products" class="stat">—</div>
        </div>

        <div>
          <div class="small">Published</div>
          <div id="published" class="stat">—</div>
        </div>

        <div>
          <div class="small">Drafts</div>
          <div id="drafts" class="stat">—</div>
        </div>

        <div>
          <div class="small">Tasks</div>
          <div id="tasks" class="stat">—</div>
        </div>

      </div>

      <button id="refresh">
        Refresh
      </button>
    </section>

    <section class="card">
      <h2>AI Manager</h2>

      <div id="chat" class="chat"></div>

      <textarea
        id="message"
        placeholder="Ask the AI Manager anything..."
      ></textarea>

      <button id="send">
        Send
      </button>

      <button
        id="reset"
        class="secondary"
      >
        Reset 24-hour chat
      </button>
    </section>

    <section class="card">
      <h2>Product Research</h2>

      <input
        id="researchInput"
        placeholder="Product or niche to research"
      >

      <button id="research">
        Research
      </button>

      <pre id="researchResult"></pre>
    </section>

    <section class="card">
      <h2>Marketing</h2>

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
      <h2>Integrations</h2>

      <button id="github">
        Test GitHub
      </button>

      <pre id="integrationResult"></pre>
    </section>

  </div>

</main>

<script>
const $ = id =>
  document.getElementById(id);

async function api(
  url,
  options = {}
) {
  const response =
    await fetch(url, {
      headers: {
        "Content-Type":
          "application/json",
        ...(options.headers || {})
      },
      ...options
    });

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data.error ||
      "Request failed"
    );
  }

  return data;
}

/* Dashboard */

async function loadDashboard() {
  try {
    const data =
      await api("/api/dashboard");

    $("products").textContent =
      data.products;

    $("published").textContent =
      data.published_products;

    $("drafts").textContent =
      data.drafts;

    $("tasks").textContent =
      data.active_tasks;
  } catch (error) {
    console.error(error);
  }
}

/* Chat */

function addMessage(
  role,
  content
) {
  const div =
    document.createElement("div");

  div.className =
    "msg " + role;

  div.textContent =
    content;

  $("chat").appendChild(div);

  $("chat").scrollTop =
    $("chat").scrollHeight;
}

async function sendMessage() {
  const input =
    $("message");

  const message =
    input.value.trim();

  if (!message) return;

  input.value = "";

  addMessage(
    "user",
    message
  );

  try {
    const data =
      await api(
        "/api/ai/chat",
        {
          method: "POST",
          body: JSON.stringify({
            message
          })
        }
      );

    addMessage(
      "assistant",
      data.answer
    );
  } catch (error) {
    addMessage(
      "assistant",
      "Error: " +
      error.message
    );
  }
}

async function resetChat() {
  await api(
    "/api/ai/chat/reset",
    {
      method: "POST"
    }
  );

  $("chat").innerHTML = "";

  addMessage(
    "assistant",
    "Chat reset."
  );
}

/* Research */

async function doResearch() {
  const query =
    $("researchInput")
      .value
      .trim();

  if (!query) return;

  $("researchResult")
    .textContent =
    "Researching...";

  try {
    const data =
      await api(
        "/api/research",
        {
          method: "POST",
          body: JSON.stringify({
            query
          })
        }
      );

    $("researchResult")
      .textContent =
      data.result;
  } catch (error) {
    $("researchResult")
      .textContent =
      error.message;
  }
}

/* Marketing */

async function doMarketing() {
  const title =
    $("marketingTitle")
      .value
      .trim();

  const description =
    $("marketingDescription")
      .value
      .trim();

  $("marketingResult")
    .textContent =
    "Generating...";

  try {
    const data =
      await api(
        "/api/marketing",
        {
          method: "POST",
          body: JSON.stringify({
            title,
            description,
            platform:
              "Instagram"
          })
        }
      );

    $("marketingResult")
      .textContent =
      data.result;
  } catch (error) {
    $("marketingResult")
      .textContent =
      error.message;
  }
}

/* GitHub */

async function testGitHub() {
  $("integrationResult")
    .textContent =
    "Testing...";

  try {
    const data =
      await api(
        "/api/integrations/github/test"
      );

    $("integrationResult")
      .textContent =
      JSON.stringify(
        data,
        null,
        2
      );
  } catch (error) {
    $("integrationResult")
      .textContent =
      error.message;
  }
}

/* Events */

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

$("refresh")
  .addEventListener(
    "click",
    loadDashboard
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
    event => {
      if (
        event.key === "Enter" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        sendMessage();
      }
    }
  );

/* Initial */

loadDashboard();

addMessage(
  "assistant",
  "Shopper's Suggestions AI Manager is online. Ask me about products, research, listings, marketing, or the website."
);
</script>

</body>
</html>`;
}
