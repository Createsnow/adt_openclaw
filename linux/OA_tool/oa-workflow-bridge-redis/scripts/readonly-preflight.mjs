import { runReadonlyPreflight } from "../src/preflight.mjs";

const result = await runReadonlyPreflight();
const { exitCode, ...payload } = result;
if (result.ok) {
  console.log(JSON.stringify(payload));
} else {
  console.error(JSON.stringify(payload));
}
process.exitCode = exitCode;
