// Writes one JSON Schema file per protocol record kind to schemas/. Runs after tsc in `npm run build`.
import { mkdirSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import { z } from "zod";
import { KINDS, schemas } from "../dist/protocol.js";

const dir = new URL("../schemas/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const kind of KINDS) {
  const schema = { $id: `gdt-${kind}.v1.schema.json`, title: `[gdt-${kind}:v1] record`, ...z.toJSONSchema(schemas[kind]) };
  writeFileSync(new URL(`gdt-${kind}.v1.schema.json`, dir), `${JSON.stringify(schema, null, 2)}\n`);
}
