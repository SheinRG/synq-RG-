// Confirms the LLM settings before the demo: lists the models the key can use
// and labels one sample reply.
//
//   npm run check-llm

import "dotenv/config";
import OpenAI from "openai";
import { requireEnv } from "../src/config.js";
import { LlmClassifier } from "../src/ai/classifier.js";
import { emptyLead } from "../src/types.js";

const apiKey = requireEnv("XAI_API_KEY");
const baseURL = process.env.LLM_BASE_URL ?? "https://api.x.ai/v1";
const model = process.env.LLM_MODEL ?? "grok-4.20-0309-non-reasoning";

async function main() {
  const client = new OpenAI({ apiKey, baseURL });
  const models = await client.models.list();
  const ids = models.data.map((m) => m.id).sort();
  console.log(`Models available at ${baseURL}:\n  ${ids.join("\n  ")}`);
  if (!ids.includes(model)) {
    console.warn(`\nLLM_MODEL "${model}" is not in that list. Pick one of the ids above.`);
  }

  const classifier = new LlmClassifier(apiKey, baseURL, model);
  const lead = { ...emptyLead("L-TEST"), name: "Priya Sharma", company: "Acme Corp" };
  const result = await classifier.classify(lead, [
    { fromLead: false, text: "Hi Priya, we help sales teams track LinkedIn replies. Worth a quick chat?", at: "" },
    { fromLead: true, text: "Sounds interesting. I'm free Monday after 11, can you send an invite?", at: "" },
  ]);
  console.log(`\nSample classification with ${model}:`, result);
  if (result.category === "Unclassified") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
