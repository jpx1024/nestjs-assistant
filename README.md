<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) application for chatting with LM Studio or an OpenAI-compatible model.

## Assistant workspace

Run `npm run start:dev` and open [http://127.0.0.1:3000](http://127.0.0.1:3000).
The NestJS server serves the HTML, CSS, and JavaScript from `public/` and
provides the conversation API under `/api/conversations`. The app listens
on the loopback interface by default. Chat and Agent share one SQLite
database. Set `DB_PATH` to change the default `data/assistant.sqlite` path.
Use Node.js 22.13+ on the Node 22 line or Node.js 24.11+. SQLite storage
uses `@nestjs/typeorm` and the `better-sqlite3` driver.

The theme follows the system by default. The theme button saves a manual
choice in the current browser.

## Streaming chat

Copy `.env.example` to `.env` when setting up a fresh checkout. With
`AI_PROVIDER=lm-studio`, start the local server in LM Studio and set
`LM_STUDIO_MODEL` to a chat model ID from
`GET http://127.0.0.1:1234/v1/models`. Set `LM_STUDIO_API_KEY` if the server
requires a token.

To switch to OpenAI, fill in `OPENAI_MODEL` and `OPENAI_API_KEY`, set
`AI_PROVIDER=openai`, and restart NestJS. Each provider has its own base URL
in `.env`. `AI_TEMPERATURE`, `AI_MAX_OUTPUT_TOKENS`, and `AI_TIMEOUT_MS`
apply to either provider.

With `npm run start:dev` running, send a message from PowerShell:

```powershell
'{"messages":[{"role":"user","content":"Give me three tips for learning NestJS."}]}' |
    curl.exe -N http://127.0.0.1:3000/api/chat/stream -H 'Content-Type: application/json' --data-binary '@-'
```

`POST /api/chat/stream` accepts a list of text messages with `user` or
`assistant` roles, ending in a `user` message. For follow-ups, include the
conversation history in that list. Invalid input returns HTTP 400. A valid
request returns an AI SDK UI message stream over SSE. Read `text-delta` chunks
to display generated text and `error` chunks to display model errors.

## Deep thinking

The composer shows **深度思考** when the active LM Studio model reports an
on/off reasoning switch. The toggle controls the next message. The page
shows when the model is thinking and switches to the answer as text arrives.
LM Studio reasoning text streams into a collapsible panel above the answer.
The panel's contents stay in the current browser tab. Retries reuse the mode
saved with the original user message.

Both `POST /api/chat/stream` and `POST /api/conversations/:id/messages`
accept an optional `thinking` boolean. With a supported LM Studio model,
`false` and `true` use the Responses API with reasoning effort `none` and
`high`, respectively. Omitting `thinking` uses the configured chat provider.
Set `AI_DEEP_MAX_OUTPUT_TOKENS` and `AI_DEEP_TIMEOUT_MS` in `.env` to
adjust the separate budget for deep thinking.

## System prompt

Edit [prompts/assistant.system.md](prompts/assistant.system.md) and restart
NestJS to apply changes. All chat routes, including conversation retries,
use this Handlebars template. `AI_PROJECT_NAME` and `AI_TIME_ZONE` in
`.env` supply the project name and timezone. The template also receives
the current date in that timezone and the server's Node.js version.
The date is refreshed for each model call. Keep `prompts/` alongside
`dist/` when deploying the compiled app.

## Agent workspace

Use the **聊天 / Agent** switch to open the Agent workspace. Conversation
history is scoped to each workspace. Agent uses its own
[system prompt](prompts/agent.system.md).

Set `AGENT_PROVIDER` and `AGENT_MODEL` in `.env` before using the Agent.
For example, use `lm-studio` and `qwen/qwen3.5-9b` to reuse the local LM
Studio connection. `AGENT_BASE_URL` and `AGENT_API_KEY` can override that
provider's shared connection settings. Add `DEEPSEEK_SEARCH_API_KEY` to
activate `web_search` through the standalone DeepSeek Search API.

Agent conversations and model metadata live under `/api/agent`. To send
a message, call `POST /api/agent/conversations/:id/messages` with
`{"content":"...","thinking":false}`. Search updates and answer text are
streamed over SSE. Completed search results and answer text are saved with
the Agent conversation. Retries reuse the original thinking option, and
disconnecting cancels the run and its search request.

## SQLite schema

TypeORM creates and updates the SQLite schema from the conversation, message,
and Agent run entities on startup. Set `DB_PATH` to a new file to start with
empty histories.

Schema synchronization defaults to enabled outside `NODE_ENV=production`.
Set `DB_SYNCHRONIZE` to `true` or `false` to override it. With synchronization
disabled, the configured SQLite file needs an existing schema.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

This project is already instrumented. To connect it, run this and approve the code it prints at [observe.nestjs.com/link](https://observe.nestjs.com/link) - signing up for free if you have no account:

```bash
$ npx @nestjs/observe link
```

It writes the app key and secret into `.env` and makes every `nest start` script (`start`, `start:dev`, `start:debug`) load it. In production, set `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment instead.

Or do it by hand: create an application and an API key at [observe.nestjs.com](https://observe.nestjs.com), and set the pair as `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment the app runs in.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
