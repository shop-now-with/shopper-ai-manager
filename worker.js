export default {
  async fetch(request, env) {
    return new Response("Shopper AI Manager is online.", {
      headers: {
        "content-type": "text/plain"
      }
    });
  }
};
