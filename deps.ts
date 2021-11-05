export { serve } from "https://deno.land/std@0.105.0/http/server.ts";
export type { Response, ServerRequest } from "https://deno.land/std@0.105.0/http/server.ts";

import * as path from "https://deno.land/std@0.105.0/path/mod.ts";

export const { join, parse, posix: { join: urlJoin } } = path;
