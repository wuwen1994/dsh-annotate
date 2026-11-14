/**
 * Host half of the web-annotate bundle.
 *
 * Everything the annotator needs runs in the Client: the sidebar browser frame
 * is captured in the renderer and the notes go through the conversation
 * service. The host therefore only has to exist so the bundle can be enabled.
 */
export function apply() {}
