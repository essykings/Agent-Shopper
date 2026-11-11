// Turns an address written in a setting into a web address the app can use.
// On Render, another service's private address arrives as "shop-northgear:10000" with no "http://"
// (Render cannot add one inside its deploy file), so a bare host and port is read as http.

export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("An address is empty.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`"${raw}" must be an http or https address.`);
  if (url.username || url.password) throw new Error("A shop address must not contain a user name or password.");
  return `${url.protocol}//${url.host}`;
}
