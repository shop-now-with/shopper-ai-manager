export default {
  async fetch(request, env) {
    try {
      const result = await env.DB
        .prepare("SELECT COUNT(*) AS count FROM products")
        .first();

      return Response.json({
        ok: true,
        manager: "online",
        database: "connected",
        products: result.count
      });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error.message
      }, { status: 500 });
    }
  }
};
