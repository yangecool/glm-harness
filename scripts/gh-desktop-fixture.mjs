/** Loopback GLM fixture shared by the GH desktop runs: one scripted write-tool
 * round then a final text, the same wire shape the product smoke uses. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const frame = payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
const delta = value => frame({ choices: [{ index: 0, delta: value }] })
const finish = reason => frame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })

/** Observations of every main-model request, for assertions outside. */
export const observations = []

/**
 * Start the loopback GLM endpoint.
 * @param options - target file the scripted write tool call creates; a
 * relative path lands in the session's own workspace, which the
 * workspace-changes recorder observes (an absolute path outside the session
 * cwd records nothing).
 * @returns the started server (call `server.address()` after listen).
 */
export function startFixture(options) {
  let round = 0
  return createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      const main = body.tools?.length > 0
      const toolResult = body.messages.some(message => message.role === 'tool')
      const assistant = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.length > 0)
      const system = body.messages.find(message => message.role === 'system')?.content ?? ''
      observations.push({
        main,
        model: body.model,
        toolResult,
        reasoning: assistant?.reasoning_content,
        system,
        tools: main ? body.tools.map(tool => tool.function.name) : undefined,
      })
      if (body.model !== 'glm-4.6') {
        response.writeHead(400).end(JSON.stringify({ error: { message: 'unknown model' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (main && !toolResult) {
        round += 1
        if (round === 1) {
          assert(body.tools.some(tool => tool.function.name === 'write'))
          response.write(delta({ reasoning_content: options.reasoning, content: null }))
          response.write(delta({ tool_calls: [{ index: 0, id: 'desktop_write', type: 'function', function: {
            name: 'write', arguments: JSON.stringify({ file_path: options.target, content: options.expected }),
          } }] }))
          response.write(finish('tool_calls'))
        } else {
          response.write(delta({ content: 'GH_DESKTOP_DONE' }))
          response.write(finish('stop'))
        }
      } else {
        if (main && toolResult) assert.equal(assistant?.reasoning_content, options.reasoning)
        response.write(delta({ content: main ? 'GH_DESKTOP_DONE' : 'Desktop smoke title' }))
        response.write(finish('stop'))
      }
      response.write(frame({ choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } } }))
      response.write(frame({ choices: [], usage: { completion_tokens: 40, total_tokens: 140 } }))
      response.end(frame('[DONE]'))
    } catch (error) {
      response.destroy(error instanceof Error ? error.message : String(error))
    }
  })
}
