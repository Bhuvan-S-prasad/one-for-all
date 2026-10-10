// `@name` in a group chat's composer (M5.11): the server routes a message to
// the member mentioned first; this only helps write the name.

/** The `@partial` being typed at the end of the text, or null. */
export function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([\p{L}\p{N}-]*)$/u.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** Replace the `@partial` at the end with a member's name. */
export function insertMention(text: string, name: string): string {
  return text.replace(/@([\p{L}\p{N}-]*)$/u, `@${name} `);
}
