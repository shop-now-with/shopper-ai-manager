const MODEL = "@cf/google/gemma-4-26b-a4b-it";

const CHAT_SESSION_ID = "main";
const MAX_HISTORY = 30;
const CHAT_RETENTION_HOURS = 24;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleAPI(request, env, url);
      }

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

      return json({
        ok: false,
        error: error?.message || "Internal server error"
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupOldChats(env));
  }
};


// ============================================================
// API ROUTER
// ============================================================

async function handleAPI(request, env, url) {
  const path = url.pathname;

  // HEALTH
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

  // DASHBOARD
  if (path === "/api/dashboard" && request.method === "GET") {
    return dashboard(env);
  }

  // PRODUCTS
  if (path === "/api/products" && request.method === "GET") {
    return getProducts(env);
  }

  if (
    path.startsWith("/api/products/") &&
    request.method === "GET"
  ) {
    const id = path.split("/").pop();
    return getProduct(env, id);
  }

  // ==========================================================
  // AI CHAT
  // ==========================================================

  if (
    path === "/api/ai/chat" &&
    request.method === "POST"
  ) {
    return aiChat(request, env);
  }

  if (
    path === "/api/ai/reset" &&
    request.method === "POST"
  ) {
    return resetChat(env);
  }

  // RESEARCH
  if (
    path === "/api/research" &&
    request.method === "POST"
  ) {
    return research(request, env);
  }

  // PRODUCT AI
  if (
    path === "/api/products/classify" &&
    request.method === "POST"
  ) {
    return classifyProduct(request, env);
  }

  if (
    path === "/api/products/improve" &&
    request.method === "POST"
  ) {
    return improveProduct(request, env);
  }

  // MARKETING
  if (
    path === "/api/marketing" &&
    request.method === "POST"
  ) {
    return marketing(request, env);
  }

  // DRAFTS
  if (
    path === "/api/drafts" &&
    request.method === "GET"
  ) {
    return getDrafts(env);
  }

  if (
    path === "/api/drafts" &&
    request.method === "POST"
  ) {
    return createDraft(request, env);
  }

  if (
    path.startsWith("/api/drafts/") &&
    path.endsWith("/publish") &&
    request.method === "POST"
  ) {
    const parts = path.split("/");
    return publishDraft(env, parts[3]);
  }

  // TASKS
  if (
    path === "/api/tasks" &&
    request.method === "GET"
  ) {
    return getTasks(env);
  }

  if (
    path === "/api/tasks" &&
    request.method === "POST"
  ) {
    return createTask(request, env);
  }

  // LOGS
  if (
    path === "/api/logs" &&
    request.method === "GET"
  ) {
    return getLogs(env);
  }

  // INTEGRATIONS
  if (
    path === "/api/integrations" &&
    request.method === "GET"
  ) {
    return integrations(env);
  }

  // CATEGORIES
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

  // GITHUB
  if (
    path === "/api/integrations/github/test" &&
    request.method === "GET"
  ) {
    return githubTest(env);
  }

  // INSTAGRAM
  if (
    path === "/api/integrations/instagram/test" &&
    request.method === "GET"
  ) {
    return json({
      ok: true,
      connected: false,
      message:
        "Instagram requires an authorized Meta/Instagram connection."
    });
  }

  // AFFILIATE
  if (
    path === "/api/integrations/affiliate/test" &&
    request.method === "GET"
  ) {
    return json({
      ok: true,
      connected: false,
      provider: "EarnKaro",
      message:
        "Affiliate API/account connection has not been configured."
    });
  }

  return json({
    ok: false,
    error: "API route not found.",
    path
  }, 404);
}


// ============================================================
// AI CHAT
// ============================================================

async function aiChat(request, env) {
  if (!env.AI) {
    return json({
      ok: false,
      error: "Workers AI binding is missing."
    }, 500);
  }

  if (!env.DB) {
    return json({
      ok: false,
      error: "D1 database binding is missing."
    }, 500);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON request."
    }, 400);
  }

  const message = String(
    body?.message ??
    body?.prompt ??
    body?.text ??
    ""
  ).trim();

  if (!message) {
    return json({
      ok: false,
      error: "Message is required."
    }, 400);
  }

  try {
    // Make sure the table exists.
    await ensureChatTable(env);

    // Automatically remove messages older than 24 hours.
    await cleanupOldChats(env);

    // --------------------------------------------------------
    // LOAD CONVERSATION
    // --------------------------------------------------------

    const historyResult = await env.DB
      .prepare(`
        SELECT role, content
        FROM manager_chat_messages
        WHERE session_id = ?
        AND created_at > datetime('now', '-24 hours')
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .bind(
        CHAT_SESSION_ID,
        MAX_HISTORY
      )
      .all();

    const history = (historyResult.results || [])
      .reverse()
      .map(row => ({
        role: row.role,
        content: row.content
      }));


    // --------------------------------------------------------
    // LOAD PRODUCT CONTEXT
    // --------------------------------------------------------

    let productContext = "";

    try {
      const products = await env.DB
        .prepare(`
          SELECT
            id,
            title,
            description,
            category,
            featured,
            published
          FROM products
          ORDER BY created_at DESC
          LIMIT 20
        `)
        .all();

      if (products.results?.length) {
        productContext = `
CURRENT SHOPPER'S SUGGESTIONS PRODUCTS:

${products.results.map(product => `
Product ID: ${product.id}
Title: ${product.title}
Category: ${product.category}
Description: ${product.description}
Featured: ${product.featured}
Published: ${product.published}
`).join("\n")}
`;
      }
    } catch (error) {
      console.log(
        "Product context unavailable:",
        error.message
      );
    }


    // --------------------------------------------------------
    // AI SYSTEM PROMPT
    // --------------------------------------------------------

    const systemMessage = `
You are the AI Manager for Shopper's Suggestions.

You are a natural conversational AI assistant.

The user should be able to talk to you normally, just like
talking to a general AI assistant.

You can answer:
- normal questions
- business questions
- coding questions
- website questions
- product questions
- marketing questions
- research questions
- affiliate marketing questions
- automation questions
- SEO questions
- social media questions
- Shopper's Suggestions questions

Do not behave like a predefined menu chatbot.

Understand previous messages and use them for follow-up
questions.

Be concise when the question is simple.

Be detailed when the user asks for details.

Do not claim that you searched the internet unless an actual
web-search integration was used.

Do not invent:
- prices
- reviews
- statistics
- affiliate links
- product specifications
- research results

If something requires an external service or API that is not
connected, explain that clearly.

Shopper's Suggestions website:
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


    // --------------------------------------------------------
    // SAVE USER MESSAGE
    // --------------------------------------------------------

    await env.DB
      .prepare(`
        INSERT INTO manager_chat_messages
        (
          session_id,
          role,
          content
        )
        VALUES (?, 'user', ?)
      `)
      .bind(
        CHAT_SESSION_ID,
        message
      )
      .run();


    // --------------------------------------------------------
    // CALL CLOUDFLARE AI
    // --------------------------------------------------------

    const result = await env.AI.run(
      MODEL,
      {
        messages
      }
    );


    // --------------------------------------------------------
    // EXTRACT AI RESPONSE
    // --------------------------------------------------------

    const answer = extractAIText(result);

    if (!answer) {
      console.error(
        "Workers AI returned an empty response:",
        JSON.stringify(result)
      );

      return json({
        ok: false,
        error: "AI returned no text response.",
        debug: result
      }, 502);
    }


    // --------------------------------------------------------
    // SAVE ASSISTANT MESSAGE
    // --------------------------------------------------------

    await env.DB
      .prepare(`
        INSERT INTO manager_chat_messages
        (
          session_id,
          role,
          content
        )
        VALUES (?, 'assistant', ?)
      `)
      .bind(
        CHAT_SESSION_ID,
        answer
      )
      .run();


    // --------------------------------------------------------
    // RESPONSE TO HTML
    // --------------------------------------------------------

    return json({
      ok: true,
      response: answer,
      answer: answer,
      model: MODEL
    });

  } catch (error) {
    console.error(
      "AI CHAT ERROR:",
      error
    );

    return json({
      ok: false,
      error: error?.message ||
        "AI request failed."
    }, 500);
  }
}


// ============================================================
// CHAT TABLE
// ============================================================

async function ensureChatTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manager_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}


// ============================================================
// DELETE CHAT OLDER THAN 24 HOURS
// ============================================================

async function cleanupOldChats(env) {
  try {
    await ensureChatTable(env);

    await env.DB
      .prepare(`
        DELETE FROM manager_chat_messages
        WHERE created_at <=
          datetime('now', '-24 hours')
      `)
      .run();

  } catch (error) {
    console.error(
      "Chat cleanup error:",
      error
    );
  }
}


// ============================================================
// RESET CHAT
// ============================================================

async function resetChat(env) {
  try {
    await ensureChatTable(env);

    await env.DB
      .prepare(`
        DELETE FROM manager_chat_messages
        WHERE session_id = ?
      `)
      .bind(CHAT_SESSION_ID)
      .run();

    return json({
      ok: true,
      message: "Conversation reset."
    });

  } catch (error) {
    return json({
      ok: false,
      error: error.message
    }, 500);
  }
}


// ============================================================
// PRODUCTS
// ============================================================

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
  const product = await env.DB
    .prepare(`
      SELECT *
      FROM products
      WHERE id = ?
    `)
    .bind(id)
    .first();

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


// ============================================================
// DASHBOARD
// ============================================================

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
    const result = await env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM manager_drafts
      `)
      .first();

    drafts = result?.count || 0;
  } catch {}

  try {
    const result = await env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM manager_tasks
      `)
      .first();

    tasks = result?.count || 0;
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
    website:
      env.WEBSITE_URL ||
      "https://shopperssuggestions.online"
  });
}


// ============================================================
// RESEARCH
// ============================================================

async function research(request, env) {
  const body = await request.json();

  const topic = String(
    body?.topic ||
    body?.query ||
    body?.message ||
    ""
  ).trim();

  if (!topic) {
    return json({
      ok: false,
      error: "Research topic is required."
    }, 400);
  }

  const result = await env.AI.run(
    MODEL,
    {
      messages: [
        {
          role: "system",
          content: `
You are a research assistant.

Be factual and clearly distinguish between known
information and things that need verification.

Do not pretend to have live internet access.
`
        },
        {
          role: "user",
          content: `
Research topic:

${topic}

Give:
1. Key information
2. Important factors
3. What should be verified
4. Practical next steps
`
        }
      ]
    }
  );

  return json({
    ok: true,
    topic,
    response: extractAIText(result)
  });
}


// ============================================================
// CLASSIFY PRODUCT
// ============================================================

async function classifyProduct(request, env) {
  const body = await request.json();

  const title = String(body?.title || "");
  const description =
    String(body?.description || "");

  const result = await env.AI.run(
    MODEL,
    {
      messages: [
        {
          role: "system",
          content: `
Choose exactly ONE category:

Tech
Home
Fashion
Beauty
Gaming
Sports
Travel
Kitchen
Office
Automotive
Electronics
Kids
Pets
Fitness
Books
Accessories
Photography
Creator
Other

Return only the category name.
`
        },
        {
          role: "user",
          content: `
Title:
${title}

Description:
${description}
`
        }
      ]
    }
  );

  return json({
    ok: true,
    category: extractAIText(result)
      .replace(/["'.]/g, "")
      .trim()
  });
}


// ============================================================
// IMPROVE PRODUCT
// ============================================================

async function improveProduct(request, env) {
  const body = await request.json();

  const title =
    String(body?.title || "");

  const description =
    String(body?.description || "");

  const result = await env.AI.run(
    MODEL,
    {
      messages: [
        {
          role: "system",
          content: `
Improve an affiliate product listing.

Return JSON:

{
  "title": "...",
  "description": "...",
  "category": "..."
}

Do not invent prices, specifications,
reviews or unsupported claims.
`
        },
        {
          role: "user",
          content: `
Title:
${title}

Description:
${description}
`
        }
      ]
    }
  );

  const text = extractAIText(result);

  let output;

  try {
    output = JSON.parse(cleanJSON(text));
  } catch {
    output = {
      title,
      description: text,
      category: "Other"
    };
  }

  return json({
    ok: true,
    result: output
  });
}


// ============================================================
// MARKETING
// ============================================================

async function marketing(request, env) {
  const body = await request.json();

  const title =
    String(body?.title || "");

  const description =
    String(body?.description || "");

  const result = await env.AI.run(
    MODEL,
    {
      messages: [
        {
          role: "system",
          content: `
Create affiliate marketing copy.

Return JSON:

{
  "hook": "...",
  "caption": "...",
  "short_caption": "...",
  "hashtags": []
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
      ]
    }
  );

  const text = extractAIText(result);

  let output;

  try {
    output = JSON.parse(cleanJSON(text));
  } catch {
    output = {
      hook: "",
      caption: text,
      short_caption: text,
      hashtags: []
    };
  }

  return json({
    ok: true,
    marketing: output
  });
}


// ============================================================
// DRAFTS
// ============================================================

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
    return json({
      ok: false,
      error: "Draft not found."
    }, 404);
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


// ============================================================
// TASKS
// ============================================================

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


// ============================================================
// LOGS
// ============================================================

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


// ============================================================
// INTEGRATIONS
// ============================================================

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
        "Requires authorized Meta/Instagram access."
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


// ============================================================
// GITHUB TEST
// ============================================================

async function githubTest(env) {
  if (
    !env.GITHUB_OWNER ||
    !env.GITHUB_REPO
  ) {
    return json({
      ok: false,
      connected: false,
      error:
        "GitHub configuration is missing."
    });
  }

  if (!env.GITHUB_TOKEN) {
    return json({
      ok: true,
      connected: false,
      message:
        "GITHUB_TOKEN is not configured."
    });
  }

  const url =
    `https://api.github.com/repos/` +
    `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;

  const response = await fetch(url, {
    headers: {
      Authorization:
        `Bearer ${env.GITHUB_TOKEN}`,
      Accept:
        "application/vnd.github+json",
      "User-Agent":
        "shopper-ai-manager"
    }
  });

  const data = await response.json();

  return json({
    ok: response.ok,
    connected: response.ok,
    repository:
      response.ok
        ? data.full_name
        : null,
    error:
      response.ok
        ? null
        : data.message
  });
}


// ============================================================
// AI RESPONSE EXTRACTION
// ============================================================

function extractAIText(result) {
  if (!result) {
    return "";
  }

  if (typeof result === "string") {
    return result.trim();
  }

  if (
    typeof result.response === "string"
  ) {
    return result.response.trim();
  }

  if (
    result.choices?.[0]?.message?.content
  ) {
    return String(
      result.choices[0].message.content
    ).trim();
  }

  if (
    result.result?.response
  ) {
    return String(
      result.result.response
    ).trim();
  }

  if (
    result.result?.choices?.[0]?.message?.content
  ) {
    return String(
      result.result.choices[0].message.content
    ).trim();
  }

  return "";
}


// ============================================================
// JSON CLEANER
// ============================================================

function cleanJSON(text) {
  return String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}


// ============================================================
// CORS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        ...corsHeaders()
      }
    }
  );
}
