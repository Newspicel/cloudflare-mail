// Stand-in for `@opentelemetry/semantic-conventions`, aliased in for the Worker
// build (see wrangler.jsonc). better-auth's instrumentation statically imports a
// handful of ATTR_* string constants from here, so the ~54 KB table ships even
// though telemetry is disabled (auth.ts). The constants are only read while
// building span attributes — which never runs with telemetry off — so the exact
// values don't matter; we just re-export the four names better-auth references.
export const ATTR_DB_COLLECTION_NAME = "db.collection.name";
export const ATTR_DB_OPERATION_NAME = "db.operation.name";
export const ATTR_HTTP_RESPONSE_STATUS_CODE = "http.response.status_code";
export const ATTR_HTTP_ROUTE = "http.route";
