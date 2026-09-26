const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const CHAT_HOURS = 24;
const MAX_HISTORY = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      // ---------------------------------------------------------
      // CORS
      // ---------------------------------------------------------
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      // ---------------------------------------------------------
      // API ROUTES
      // ---------------------------------------------------------
      if (url.pathname.startsWith("/api/")) {
        return await handleAPI(request, env, url);
      }

      // ---------------------------------------------------------
      // STATIC WEBSITE
      // ---------------------------------------------------------
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({
        ok: true,
        manager: "shopper-ai-manager",
        status: "online"
      });
    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error: error?.message || "Internal server error"
        },
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupOldChats(env));
  }
};


// =============================================================
// API ROUTER
// =============================================================

async function handleAPI(request, env, url) {
  const path = url.pathname;

  // ---------------------------------------------------------
  // HEALTH
  // ---------------------------------------------------------

  if (path === "/api/health") {
    return json({
      ok: true,
      manager: "shopper-ai-manager",
      ai: !!env.AI,
      database: !!env.DB,
      assets: !!env.ASSETS,
      model: MODEL
    });
  }

  // ---------------------------------------------------------
  // DASHBOARD
  // ---------------------------------------------------------

  if (path === "/api/dashboard" && request.method === "GET") {
    return await dashboard(env);
  }

  // ---------------------------------------------------------
  // PRODUCTS
  // ---------------------------------------------------------

  if (path === "/api/products" && request.method === "GET") {
    return await getProducts(env);
  }

  if (
    path.startsWith("/api/products/") &&
    request.method === "GET"
  ) {
    const id = path.split("/").pop();
    return await getProduct(env, id);
  }

  // ---------------------------------------------------------
  // AI CHAT
  // ---------------------------------------------------------

  if (path === "/api/ai/chat" && request.method === "POST") {
    return await aiChat(request, env);
  }

  // Reset conversation
  if (path === "/api/ai/reset" && request.method === "POST") {
    return await resetChat(env);
  }

  // ---------------------------------------------------------
  // AI RESEARCH
  // ---------------------------------------------------------

  if (path === "/api/research" && request.method === "POST") {
    return await research(request, env);
  }

  // ---------------------------------------------------------
  // PRODUCT AI
  // ---------------------------------------------------------

  if (
    path === "/api/products/classify" &&
    request.method === "POST"
  ) {
    return await classifyProduct(request, env);
  }

  if (
    path === "/api/products/improve" &&
    request.method === "POST"
  ) {
    return await improveProduct(request, env);
  }

  // ---------------------------------------------------------
  // MARKETING
  // ---------------------------------------------------------

  if (path === "/api/marketing" && request.method === "POST") {
    return await marketing(request, env);
  }

  // ---------------------------------------------------------
  // DRAFTS
  // ---------------------------------------------------------

  if (path === "/api/drafts" && request.method === "GET") {
    return await getDrafts(env);
  }

  if (path === "/api/drafts" && request.method === "POST") {
    return await createDraft(request, env);
  }

  if (
    path.startsWith("/api/drafts/") &&
    path.endsWith("/publish") &&
    request.method === "POST"
  ) {
    const parts = path.split("/");
    const id = parts[3];

    return await publishDraft(env, id);
  }

  // ---------------------------------------------------------
  // TASKS
  // ---------------------------------------------------------

  if (path === "/api/tasks" && request.method === "GET") {
    return await getTasks(env);
  }

  if (path === "/api/tasks" && request.method === "POST") {
    return await createTask(request, env);
  }

  // ---------------------------------------------------------
  // LOGS
  // ---------------------------------------------------------

  if (path === "/api/logs" && request.method === "GET") {
    return await getLogs(env);
  }

  // ---------------------------------------------------------
  // INTEGRATIONS
  // ---------------------------------------------------------

  if (
    path === "/api/integrations" &&
    request.method === "GET"
  ) {
    return await integrations(env);
  }

  // ---------------------------------------------------------
  // CATEGORIES
  // ---------------------------------------------------------

  if (
    path === "/api/categories" &&
    request.method === "GET"
  ) {
    return json({
      ok: true,
      categories: [
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
      ]
    });
  }

  // ---------------------------------------------------------
  // GITHUB TEST
  // ---------------------------------------------------------

  if (
    path === "/api/integrations/github/test" &&
    request.method === "GET"
  ) {
    return await githubTest(env);
  }

  // ---------------------------------------------------------
  // INSTAGRAM STATUS
  // ---------------------------------------------------------

  if (
    path === "/api/integrations/instagram/test" &&
    request.method === "GET"
  ) {
    return json({
      ok: true,
      connected: false,
      message:
        "Instagram publishing requires an authorized Instagram/Meta connection."
    });
  }

  // ---------------------------------------------------------
  // AFFILIATE STATUS
  // ---------------------------------------------------------

  if (
    path === "/api/integrations/affiliate/test" &&
    request.method === "GET"
  ) {
    return json({
      ok: true,
      connected: false,
      provider: "EarnKaro",
      message:
        "Affiliate account/API connection has not been configured yet."
    });
  }

  return json(
    {
      ok: false,
      error: "API route not found.",
      path
    },
    404
  );
}


// =============================================================
// AI CHAT
// =============================================================

async function aiChat(request, env) {
  if (!env.AI) {
    return json(
      {
        ok: false,
        error: "Workers AI binding is missing."
      },
      500
    );
  }

  if (!env.DB) {
    return json(
      {
        ok: false,
        error: "D1 database binding is missing."
      },
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid JSON body."
      },
      400
    );
  }

  const message = String(
    body?.message ??
    body?.prompt ??
    body?.text ??
    ""
  ).trim();

  if (!message) {
    return json(
      {
        ok: false,
        error: "Message is required."
      },
      400
    );
  }

  try {
    await ensureChatTable(env);

    // Remove conversations older than 24 hours
    await cleanupOldChats(env);

    // Get recent conversation
    const historyResult = await env.DB
      .prepare(`
        SELECT role, content
        FROM manager_chat_messages
        WHERE created_at > datetime('now', '-24 hours')
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .bind(MAX_HISTORY)
      .all();

    const rows = historyResult.results || [];

    const history = rows
      .reverse()
      .map(row => ({
        role: row.role,
        content: row.content
      }));

    // -------------------------------------------------------
    // PRODUCT CONTEXT
    // -------------------------------------------------------

    let productContext = "";

    try {
      const products = await env.DB
        .prepare(`
          SELECT
            id,
            title,
            description,
            category,
            affiliate_url,
            featured,
            published
          FROM products
          ORDER BY created_at DESC
          LIMIT 20
        `)
        .all();

      if (products.results?.length) {
        productContext = `
Current Shopper's Suggestions products:

${products.results.map(p => `
ID: ${p.id}
Title: ${p.title}
Category: ${p.category}
Description: ${p.description}
Featured: ${p.featured}
Published: ${p.published}
`).join("\n")}
`;
      }
    } catch (error) {
      console.log("Product context unavailable:", error.message);
    }

    // -------------------------------------------------------
    // SYSTEM PROMPT
    // -------------------------------------------------------

    const systemMessage = `
You are the AI Manager for Shopper's Suggestions.

You are a helpful general-purpose conversational AI assistant.

The user can ask you normal questions, business questions,
coding questions, product questions, marketing questions,
website questions, research questions, or questions about
Shopper's Suggestions.

Answer naturally and directly.

Do not behave like a menu or predefined chatbot.

Remember the conversation provided in this request and use it
to understand follow-up questions.

You are helping operate Shopper's Suggestions, an affiliate
product discovery website.

You can help with:
- product research
- product ideas
- product descriptions
- titles
- categories
- affiliate marketing
- website improvements
- SEO ideas
- social media ideas
- automation planning
- technical problems
- code explanations
- business strategy

Important:
You do NOT have unrestricted internet browsing just because
you are the AI Manager.

Do not pretend you searched the internet when you did not.

Do not invent affiliate links, product prices, statistics,
reviews, or research results.

If something requires an external integration, clearly say so.

Current website:
${env.WEBSITE_URL || "https://shopperssuggestions.online"}

${productContext}
`;

    const messages = [
      {
        role: "system",
        content: systemMessage
      },
      ...history,
      {
        role: "user",
        content: message
      }
    ];

    // -------------------------------------------------------
    // SAVE USER MESSAGE
    // -------------------------------------------------------

    await env.DB
      .prepare(`
        INSERT INTO manager_chat_messages
        (role, content)
        VALUES ('user', ?)
      `)
      .bind(message)
      .run();

    // -------------------------------------------------------
    // RUN GEMMA
    // -------------------------------------------------------

    const result = await env.AI.run(
      MODEL,
      {
        messages,
        chat_template_kwargs: {
          enable_thinking: false
        }
      }
    );

    // -------------------------------------------------------
    // EXTRACT RESPONSE
    // -------------------------------------------------------

    let answer = "";

    if (typeof result === "string") {
      answer = result;
    }

    if (!answer && result?.response) {
      answer = result.response;
    }

    if (
      !answer &&
      result?.choices?.[0]?.message?.content
    ) {
      answer = result.choices[0].message.content;
    }

    if (
      !answer &&
      result?.result?.response
    ) {
      answer = result.result.response;
    }

    if (
      !answer &&
      result?.result?.choices?.[0]?.message?.content
    ) {
      answer =
        result.result.choices[0].message.content;
    }

    if (!answer) {
      console.error(
        "Unexpected Workers AI response:",
        JSON.stringify(result)
      );

      return json(
        {
          ok: false,
          error: "AI returned no text response.",
          debug: result
        },
        502
      );
    }

    answer = String(answer).trim();

    // -------------------------------------------------------
    // SAVE AI RESPONSE
    // -------------------------------------------------------

    await env.DB
      .prepare(`
        INSERT INTO manager_chat_messages
        (role, content)
        VALUES ('assistant', ?)
      `)
      .bind(answer)
      .run();

    return json({
      ok: true,
      response: answer,
      answer,
      model: MODEL
    });

  } catch (error) {
    console.error("AI CHAT ERROR:", error);

    return json(
      {
        ok: false,
        error: error?.message || "AI request failed."
      },
      500
    );
  }
}


// =============================================================
// CHAT DATABASE
// =============================================================

async function ensureChatTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manager_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function cleanupOldChats(env) {
  try {
    await ensureChatTable(env);

    await env.DB.prepare(`
      DELETE FROM manager_chat_messages
      WHERE created_at <= datetime('now', '-24 hours')
    `).run();
  } catch (error) {
    console.error("Chat cleanup error:", error);
  }
}

async function resetChat(env) {
  await ensureChatTable(env);

  await env.DB.prepare(`
    DELETE FROM manager_chat_messages
  `).run();

  return json({
    ok: true,
    message: "AI conversation reset."
  });
}


// =============================================================
// PRODUCTS
// =============================================================

async function getProducts(env) {
  const result = await env.DB
    .prepare(`
      SELECT *
      FROM products
      ORDER BY created_at DESC
    `)
    .all();

  return json({
    ok: true,
    products: result.results || []
  });
}

async function getProduct(env, id) {
  const result = await env.DB
    .prepare(`
      SELECT *
      FROM products
      WHERE id = ?
    `)
    .bind(id)
    .first();

  if (!result) {
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
    product: result
  });
}


// =============================================================
// DASHBOARD
// =============================================================

async function dashboard(env) {
  const products = await env.DB
    .prepare(`
      SELECT COUNT(*) AS count
      FROM products
    `)
    .first();

  const published = await env.DB
    .prepare(`
      SELECT COUNT(*) AS count
      FROM products
      WHERE published = 1
    `)
    .first();

  const featured = await env.DB
    .prepare(`
      SELECT COUNT(*) AS count
      FROM products
      WHERE featured = 1
    `)
    .first();

  let drafts = 0;
  let tasks = 0;

  try {
    const d = await env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM manager_drafts
      `)
      .first();

    drafts = d?.count || 0;
  } catch {}

  try {
    const t = await env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM manager_tasks
      `)
      .first();

    tasks = t?.count || 0;
  } catch {}

  return json({
    ok: true,
    products: products?.count || 0,
    published: published?.count || 0,
    featured: featured?.count || 0,
    drafts,
    tasks,
    ai: !!env.AI,
    database: !!env.DB,
    website: env.WEBSITE_URL || ""
  });
}


// =============================================================
// AI RESEARCH
// =============================================================

async function research(request, env) {
  const body = await request.json();

  const topic = String(
    body?.topic ||
    body?.query ||
    body?.message ||
    ""
  ).trim();

  if (!topic) {
    return json(
      {
        ok: false,
        error: "Research topic is required."
      },
      400
    );
  }

  const prompt = `
Research planning request:

${topic}

Give a useful research-oriented answer.

Separate:
1. What is known
2. What should be verified
3. Important factors
4. Practical next steps

Do not pretend to have live web access.
`;

  const result = await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You are a careful research assistant."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    chat_template_kwargs: {
      enable_thinking: false
    }
  });

  const answer = extractAIText(result);

  return json({
    ok: true,
    topic,
    response: answer
  });
}


// =============================================================
// CLASSIFY PRODUCT
// =============================================================

async function classifyProduct(request, env) {
  const body = await request.json();

  const title = String(body?.title || "");
  const description = String(body?.description || "");

  const result = await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content: `
Classify products for Shopper's Suggestions.

Choose exactly one category from:

Tech, Home, Fashion, Beauty, Gaming, Sports,
Travel, Kitchen, Office, Automotive, Electronics,
Kids, Pets, Fitness, Books, Accessories,
Photography, Creator, Other.

Return only the category name.
`
      },
      {
        role: "user",
        content: `
Title: ${title}

Description:
${description}
`
      }
    ],
    chat_template_kwargs: {
      enable_thinking: false
    }
  });

  const category = extractAIText(result)
    .replace(/["'.]/g, "")
    .trim();

  return json({
    ok: true,
    category
  });
}


// =============================================================
// IMPROVE PRODUCT
// =============================================================

async function improveProduct(request, env) {
  const body = await request.json();

  const title = String(body?.title || "");
  const description = String(body?.description || "");

  const result = await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content: `
You improve affiliate product listings.

Return JSON with:

{
  "title": "...",
  "description": "...",
  "category": "..."
}

Do not invent technical specifications,
prices, guarantees, reviews or claims.
`
      },
      {
        role: "user",
        content: `
Product title:
${title}

Description:
${description}
`
      }
    ],
    chat_template_kwargs: {
      enable_thinking: false
    }
  });

  const text = extractAIText(result);

  let parsed;

  try {
    parsed = JSON.parse(cleanJSON(text));
  } catch {
    parsed = {
      title,
      description: text,
      category: "Other"
    };
  }

  return json({
    ok: true,
    result: parsed
  });
}


// =============================================================
// MARKETING
// =============================================================

async function marketing(request, env) {
  const body = await request.json();

  const title = String(body?.title || "");
  const description = String(body?.description || "");

  const result = await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content: `
Create marketing copy for an affiliate product.

Return JSON:

{
  "hook": "...",
  "caption": "...",
  "short_caption": "...",
  "hashtags": ["...", "...", "..."]
}

Do not make unsupported claims.
`
      },
      {
        role: "user",
        content: `
Product:
${title}

Description:
${description}
`
      }
    ],
    chat_template_kwargs: {
      enable_thinking: false
    }
  });

  const text = extractAIText(result);

  let parsed;

  try {
    parsed = JSON.parse(cleanJSON(text));
  } catch {
    parsed = {
      hook: "",
      caption: text,
      short_caption: text,
      hashtags: []
    };
  }

  return json({
    ok: true,
    marketing: parsed
  });
}


// =============================================================
// DRAFTS
// =============================================================

async function ensureDraftTable(env) {
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
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function getDrafts(env) {
  await ensureDraftTable(env);

  const result = await env.DB
    .prepare(`
      SELECT *
      FROM manager_drafts
      ORDER BY created_at DESC
    `)
    .all();

  return json({
    ok: true,
    drafts: result.results || []
  });
}

async function createDraft(request, env) {
  await ensureDraftTable(env);

  const body = await request.json();

  const result = await env.DB
    .prepare(`
      INSERT INTO manager_drafts
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
        video_url
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      body?.title || "",
      body?.description || "",
      body?.affiliate_url || "",
      body?.category || "Other",
      body?.image1_url || "",
      body?.image2_url || "",
      body?.image3_url || "",
      body?.image4_url || "",
      body?.image5_url || "",
      body?.video_url || ""
    )
    .run();

  return json({
    ok: true,
    id: result.meta?.last_row_id
  });
}

async function publishDraft(env, id) {
  await ensureDraftTable(env);

  const draft = await env.DB
    .prepare(`
      SELECT *
      FROM manager_drafts
      WHERE id = ?
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
        video_url,
        published
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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

  await env.DB
    .prepare(`
      UPDATE manager_drafts
      SET status = 'published'
      WHERE id = ?
    `)
    .bind(id)
    .run();

  return json({
    ok: true,
    published: true,
    product_id: result.meta?.last_row_id
  });
}


// =============================================================
// TASKS
// =============================================================

async function ensureTaskTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manager_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function getTasks(env) {
  await ensureTaskTable(env);

  const result = await env.DB
    .prepare(`
      SELECT *
      FROM manager_tasks
      ORDER BY created_at DESC
      LIMIT 100
    `)
    .all();

  return json({
    ok: true,
    tasks: result.results || []
  });
}

async function createTask(request, env) {
  await ensureTaskTable(env);

  const body = await request.json();

  const result = await env.DB
    .prepare(`
      INSERT INTO manager_tasks
      (type, payload)
      VALUES (?, ?)
    `)
    .bind(
      body?.type || "general",
      JSON.stringify(body?.payload || {})
    )
    .run();

  return json({
    ok: true,
    id: result.meta?.last_row_id
  });
}


// =============================================================
// LOGS
// =============================================================

async function ensureLogsTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manager_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function getLogs(env) {
  await ensureLogsTable(env);

  const result = await env.DB
    .prepare(`
      SELECT *
      FROM manager_logs
      ORDER BY created_at DESC
      LIMIT 100
    `)
    .all();

  return json({
    ok: true,
    logs: result.results || []
  });
}


// =============================================================
// INTEGRATIONS
// =============================================================

async function integrations(env) {
  return json({
    ok: true,

    workers_ai: {
      connected: !!env.AI,
      model: MODEL
    },

    database: {
      connected: !!env.DB,
      name: "product-db"
    },

    github: {
      configured:
        !!env.GITHUB_OWNER &&
        !!env.GITHUB_REPO
    },

    website: {
      configured: !!env.WEBSITE_URL,
      url: env.WEBSITE_URL || ""
    },

    instagram: {
      connected: false,
      message:
        "Requires an authorized Meta/Instagram connection."
    },

    affiliate: {
      connected: false,
      provider: "EarnKaro"
    },

    telegram: {
      connected: false
    }
  });
}


// =============================================================
// GITHUB TEST
// =============================================================

async function githubTest(env) {
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) {
    return json({
      ok: false,
      connected: false,
      error: "GitHub variables are missing."
    });
  }

  if (!env.GITHUB_TOKEN) {
    return json({
      ok: true,
      connected: false,
      message: "GITHUB_TOKEN secret is not configured."
    });
  }

  const url =
    `https://api.github.com/repos/` +
    `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;

  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "shopper-ai-manager"
    }
  });

  const data = await response.json();

  return json({
    ok: response.ok,
    connected: response.ok,
    repository: response.ok
      ? data.full_name
      : null,
    error: response.ok
      ? null
      : data.message
  });
}


// =============================================================
// HELPERS
// =============================================================

function extractAIText(result) {
  if (!result) return "";

  if (typeof result === "string") {
    return result;
  }

  if (result.response) {
    return String(result.response);
  }

  if (
    result.choices &&
    result.choices[0] &&
    result.choices[0].message
  ) {
    return String(
      result.choices[0].message.content || ""
    );
  }

  if (result.result?.response) {
    return String(result.result.response);
  }

  if (
    result.result?.choices &&
    result.result.choices[0]?.message
  ) {
    return String(
      result.result.choices[0].message.content || ""
    );
  }

  return "";
}

function cleanJSON(text) {
  return String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders()
      }
    }
  );
}
