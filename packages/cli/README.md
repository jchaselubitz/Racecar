# racecar-cli

`racecar` is an agent-agnostic, launcher-agnostic control-plane CLI for cloud
coding sandboxes. It bakes a project's environment into a reusable snapshot,
spins up one isolated sandbox per feature branch, runs coding agents inside
those sandboxes across sequential prompts, and lets you talk to each agent —
live through a multiplexed terminal, or asynchronously through a durable
mailbox. [Daytona](https://www.daytona.io) is the sandbox provider underneath,
reached only through an adapter.

Racecar has no server of its own: the CLI is a stateless client, each sandbox
hosts its own small daemon, and clients talk to sandboxes directly.

## Install

```bash
npm install -g racecar-cli
```

Requires Node.js >= 24. Then:

```bash
racecar --help
```

Or run without installing:

```bash
npx racecar-cli --help
```

## Concepts

| Concept      | What it is                                                              |
| ------------ | ----------------------------------------------------------------------- |
| **Project**  | A named repo + environment definition and its immutable snapshots.      |
| **Snapshot** | A baked, shareable, credential-free environment image for a project.    |
| **Sandbox**  | One stateful, isolated session created from a snapshot. Lives across runs. |
| **Run**      | One agent invocation inside a sandbox. Runs execute sequentially.       |
| **Mailbox**  | A durable per-sandbox message queue between the user and the agent.     |

## Links

- [Source & full documentation](https://github.com/jchaselubitz/Racecar)
- [Overlord](https://www.ovld.ai) — the launcher Racecar integrates with

## License

MIT
