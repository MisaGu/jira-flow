// A module error: code from enums.code, message in English, status and data of the Jira answer when there was one.
// Hosts show enums.code.label(code, lang) to people and keep the message for logs.
export class FlowError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'FlowError'
    this.code = code
    Object.assign(this, extra)
  }
}

export const fail = (code, message, extra) => {
  throw new FlowError(code, message, extra)
}

// Network trouble, Jira overload and rate limits pass with time; everything else needs a person.
export const retryable = (e) => ['NETWORK', 'TIMEOUT'].includes(e?.code) || e?.status === 429 || e?.status >= 500
