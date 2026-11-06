// JSON errors for everything unmatched. Install last, so every route is reachable first.
const { err } = require("../http/helpers");

function installErrorHandlers(app) {
  // JSON errors for everything unmatched (registered last so the extension routes are reachable).
  app.use("/api", (_req, res) => err(res, 404, "not_found", "No such endpoint"));
  app.use((e, _req, res, _next) => {
    if (e.type === "entity.parse.failed") return err(res, 400, "invalid_json", "Request body is not valid JSON");
    if (e.type === "entity.too.large") return err(res, 413, "payload_too_large", "Request body is too large");
    console.error("[api]", e);
    err(res, 500, "internal_error", "Something went wrong");
  });
}

module.exports = { installErrorHandlers };
