// ---------------------------------------------------------------------------
// Eval fixtures (T10 / D13).
//
// VISION_INPUTS: 10 diverse founder vision prompts fed to the live planner by
// run-eval.ts. The runner validates each resulting team with
// validateSpawnResult. These are inputs only — there is no single "correct"
// team, so we grade structure/coherence, not exact output.
//
// TOOL_USE_SCENARIOS: prompts where the right tool is unambiguous, used to
// grade tool selection + argument validity against the registry.
// ---------------------------------------------------------------------------

export interface VisionInput {
  id: string;
  /** What the founder types into onboarding. */
  vision: string;
  /** Rough expected team size, for the runner's sanity log (not a hard gate). */
  expectAgentsBetween: [number, number];
}

export const VISION_INPUTS: VisionInput[] = [
  {
    id: "saas-analytics",
    vision:
      "I'm building a SaaS analytics dashboard for e-commerce stores. I need help with product, marketing, and customer support.",
    expectAgentsBetween: [2, 4],
  },
  {
    id: "indie-game",
    vision:
      "Solo indie game dev shipping a roguelike on Steam. Want help with community, playtesting coordination, and release marketing.",
    expectAgentsBetween: [2, 4],
  },
  {
    id: "newsletter",
    vision: "I run a paid tech newsletter. I want agents to research topics, draft issues, and grow subscribers.",
    expectAgentsBetween: [2, 4],
  },
  {
    id: "open-source",
    vision:
      "Maintainer of a popular open-source TypeScript library. Need help triaging issues, writing docs, and planning releases.",
    expectAgentsBetween: [2, 4],
  },
  {
    id: "consultancy",
    vision: "Two-person design consultancy. We want help with lead gen, proposal drafting, and project status tracking.",
    expectAgentsBetween: [2, 4],
  },
  {
    id: "hardware",
    vision:
      "Building a hardware startup making a smart plant sensor. Pre-launch. Need help with supply chain research, crowdfunding prep, and PR.",
    expectAgentsBetween: [2, 5],
  },
  {
    id: "creator",
    vision: "Full-time YouTuber covering AI tools. I want agents for scripting, thumbnail/title testing, and sponsor outreach.",
    expectAgentsBetween: [2, 4],
  },
  {
    id: "local-biz",
    vision: "I own a coffee roastery with a small online shop. Help me with social media, wholesale outreach, and inventory reminders.",
    expectAgentsBetween: [2, 4],
  },
  {
    id: "fintech",
    vision:
      "Early fintech building a budgeting app for freelancers. Need help with compliance research, content marketing, and user interviews.",
    expectAgentsBetween: [2, 5],
  },
  {
    id: "minimal",
    vision: "I just need one assistant to help me keep track of my startup's todos and follow-ups.",
    expectAgentsBetween: [1, 2],
  },
];

export interface ToolUseScenario {
  id: string;
  /** Instruction given to the agent for this turn. */
  instruction: string;
  /** The tool a correct agent should choose. */
  expectedTool: string;
  /** A note on what valid args look like (for the runner's report). */
  argsHint: string;
}

export const TOOL_USE_SCENARIOS: ToolUseScenario[] = [
  {
    id: "read-a-file",
    instruction: "Read the contents of package.json in the project root.",
    expectedTool: "read_file",
    argsHint: "{ path: 'package.json' }",
  },
  {
    id: "message-a-peer",
    instruction: "Ask the content-scheduler agent whether this week's posts are drafted.",
    expectedTool: "send_message",
    argsHint: "{ to_agent: 'content-scheduler', content: '...' }",
  },
  {
    id: "report-a-finding",
    instruction: "Log that you finished reviewing the competitor analysis.",
    expectedTool: "report_action",
    argsHint: "{ action_type: 'review_done', summary: '...' }",
  },
  {
    id: "fetch-a-url",
    instruction: "Fetch the JSON from https://api.github.com/repos/vercel/next.js to check its star count.",
    expectedTool: "http_fetch",
    argsHint: "{ url: 'https://api.github.com/...' }",
  },
  {
    id: "announce-to-team",
    instruction: "Tell everyone on the team that the launch date moved to Friday.",
    expectedTool: "broadcast",
    argsHint: "{ content: 'Launch moved to Friday' }",
  },
];
