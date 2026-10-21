// "Use with your apps" tab: connection settings and copy-ready examples.
import { $, copy, mask, toast } from './dom';
import { app, session, uiRequest, type Session } from './session';

type SnippetId = 'py-openai' | 'py-anthropic' | 'js' | 'curl' | 'env';

let keyShown = false;
let snippetId: SnippetId = 'py-openai';

function snippet(id: SnippetId, key: string, url: string): string {
  switch (id) {
    case 'py-openai':
      return `# pip install openai
from openai import OpenAI

client = OpenAI(base_url="${url}/v1", api_key="${key}")
reply = client.chat.completions.create(
    model="claude-web",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)`;
    case 'py-anthropic':
      return `# pip install anthropic
import anthropic

client = anthropic.Anthropic(base_url="${url}", api_key="${key}")
message = client.messages.create(
    model="claude-web",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)`;
    case 'js':
      return `const res = await fetch("${url}/v1/chat/completions", {
  method: "POST",
  headers: { "Authorization": "Bearer ${key}", "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-web",
    messages: [{ role: "user", content: "Hello!" }],
  }),
});
console.log((await res.json()).choices[0].message.content);`;
    case 'curl':
      return `curl ${url}/v1/chat/completions -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d "{\\"model\\":\\"claude-web\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Hello!\\"}]}"`;
    case 'env':
      return `# Many tools read these. Windows PowerShell:
$env:OPENAI_BASE_URL    = "${url}/v1"
$env:OPENAI_API_KEY     = "${key}"
$env:ANTHROPIC_BASE_URL = "${url}"
$env:ANTHROPIC_API_KEY  = "${key}"

# macOS / Linux:
export OPENAI_BASE_URL="${url}/v1"
export OPENAI_API_KEY="${key}"
export ANTHROPIC_BASE_URL="${url}"
export ANTHROPIC_API_KEY="${key}"`;
  }
}

export function renderApps(s: Session): void {
  $('api-key').textContent = keyShown ? s.apiKey : mask(s.apiKey);
  $('key-show').textContent = keyShown ? 'Hide' : 'Show';
  $('url-openai').textContent = `${s.apiUrl}/v1`;
  $('url-anthropic').textContent = s.apiUrl;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-snippet]')) {
    b.setAttribute('aria-selected', String(b.dataset.snippet === snippetId));
  }
  $('snippet').textContent = snippet(snippetId, keyShown ? s.apiKey : mask(s.apiKey), s.apiUrl);
}

export function initApps(onKeysReset: (s: Session) => void): void {
  $('key-show').addEventListener('click', () => {
    keyShown = !keyShown;
    renderApps(session());
  });

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-snippet]')) {
    b.addEventListener('click', () => {
      snippetId = b.dataset.snippet as SnippetId;
      renderApps(session());
    });
  }

  $('snippet-copy').addEventListener('click', () => {
    const s = session();
    void copy(snippet(snippetId, s.apiKey, s.apiUrl), 'Example copied');
  });

  $('reset-keys').addEventListener('click', async () => {
    const sure = confirm(
      'Reset the API key and pairing code?\n\nYour apps stop working until you give them the new key, and the extension disconnects until you paste the new pairing code.'
    );
    if (!sure) return;
    try {
      app.session = await uiRequest<Session>('POST', '/ui/reset-keys');
      onKeysReset(app.session);
      toast('New keys created. Paste the new pairing code into the extension.');
    } catch (e) {
      toast(`Couldn't reset keys: ${(e as Error).message}`);
    }
  });
}
