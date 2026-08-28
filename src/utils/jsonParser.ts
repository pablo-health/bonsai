/**
 * Remove markdown code fences from a string.
 * 
 * Handles strings in the following formats:
 * - Markdown code block: ```json\n{...}\n```
 * - Plain JSON string: {...}
 * 
 * @param input - The string to parse as JSON
 * @returns Plain JSON string without markdown code fences
 */
export function removeJsonMarkers(input: string): unknown {
  let jsonString = input.trim();

  // Check if the string starts with ```json and ends with ```
  const hasJsonCodeFence = jsonString.startsWith('```json');
  const hasClosingFence = jsonString.endsWith('```');

  if (hasJsonCodeFence && hasClosingFence) {
    // Extract content between the markers
    // Remove opening ```json and closing ```
    const lines = jsonString.split('\n');
    
    // Remove first line (```json) and last line (```)
    const contentLines = lines.slice(1, -1);
    jsonString = contentLines.join('\n').trim();
  } else if (jsonString.startsWith('```') && hasClosingFence) {
    // Handle generic code fence (```\n{...}\n```)
    const lines = jsonString.split('\n');
    const contentLines = lines.slice(1, -1);
    jsonString = contentLines.join('\n').trim();
  }

  // Clean JSON string
  return jsonString;
}

export function parseJsonFromMarkdown(input: string): unknown {
  const jsonString = removeJsonMarkers(input) as string;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    // Last resort: take the outermost braced span and try that.
    //
    // Every transformer prompt in this project already SHOUTS "output only JSON", and they shout
    // it because models keep narrating anyway - "I'm listening to a therapy practice intake
    // call..." followed by a perfectly good fenced object, or a correct object followed by a
    // sentence explaining it. removeJsonMarkers only strips a fence when the fence is the whole
    // string, so one stray sentence discarded an entire extraction and a caller's corrected name
    // never reached their record.
    //
    // Recovering here rather than in each prompt means the failure costs a slightly odd log line
    // instead of the turn's data. A prompt that produces no object at all still throws, which is
    // the case that genuinely needs to be seen.
    const first = jsonString.indexOf('{');
    const last = jsonString.lastIndexOf('}');
    if (first === -1 || last <= first) throw error;
    return JSON.parse(jsonString.slice(first, last + 1));
  }
} 