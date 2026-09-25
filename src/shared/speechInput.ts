// "requested" confirms a system input request, not microphone or recognition state.
export type SpeechInputOpenResult = 'requested' | 'unsupported' | 'not_focused' | 'keys_held' | 'failed'

export interface SpeechInputApi {
  open(): Promise<SpeechInputOpenResult>
}
