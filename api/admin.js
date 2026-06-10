// ── Joias Preciosa · API admin (Vercel serverless) ──
// Backend = o próprio repositório GitHub (produtos.json + pasta /img).
// Segredos vêm de variáveis de ambiente na Vercel: GITHUB_TOKEN e ADMIN_PASSWORD.

const REPO = process.env.GITHUB_REPO || 'Giovani-P/joiaspreciosa';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const API = `https://api.github.com/repos/${REPO}/contents`;
const DATA_FILE = 'produtos.json';

const PREFIX = { brincos:'BR', colares:'CL', conjuntos:'CJ', aneis:'AN', bolsas:'BO', relogios:'RE' };

function gh(path, opts = {}) {
  return fetch(`${API}/${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'joias-preciosa-admin',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
}

async function getData() {
  const r = await gh(`${DATA_FILE}?ref=${BRANCH}&t=${Date.now()}`, { cache: 'no-store' });
  if (r.status === 404) return { arr: [], sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${DATA_FILE}: ${r.status}`);
  const j = await r.json();
  const content = Buffer.from(j.content, 'base64').toString('utf8');
  return { arr: JSON.parse(content), sha: j.sha };
}

async function putData(arr, sha, message) {
  const content = Buffer.from(JSON.stringify(arr, null, 2) + '\n', 'utf8').toString('base64');
  const r = await gh(DATA_FILE, {
    method: 'PUT',
    body: JSON.stringify({ message, content, sha: sha || undefined, branch: BRANCH }),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${DATA_FILE}: ${r.status} ${await r.text()}`);
  // pede pro jsDelivr atualizar o cache do site na hora
  fetch(`https://purge.jsdelivr.net/gh/${REPO}@${BRANCH}/${DATA_FILE}`).catch(() => {});
  return r.json();
}

async function putImage(filename, base64) {
  const r = await gh(`img/${filename}`, {
    method: 'PUT',
    body: JSON.stringify({ message: `foto: ${filename}`, content: base64, branch: BRANCH }),
  });
  if (!r.ok) throw new Error(`GitHub PUT img/${filename}: ${r.status}`);
  return `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/img/${filename}`;
}

function nextRef(arr, cat) {
  const pre = PREFIX[cat] || 'XX';
  let max = 0;
  for (const p of arr) {
    const m = String(p.id || '').match(new RegExp(`^${pre}(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${pre}${String(max + 1).padStart(3, '0')}`;
}

// converte ["data:image/jpeg;base64,XXXX", ...] em URLs publicas (faz upload)
async function uploadImages(dataUrls, ref) {
  const urls = [];
  let n = 1;
  for (const d of dataUrls || []) {
    const b64 = String(d).replace(/^data:image\/\w+;base64,/, '');
    if (!b64) continue;
    const filename = `${ref}-${Date.now()}-${n}.jpg`;
    urls.push(await putImage(filename, b64));
    n++;
  }
  return urls;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'método não permitido' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { action, password } = body;

    if (!process.env.ADMIN_PASSWORD || !process.env.GITHUB_TOKEN)
      return res.status(500).json({ error: 'servidor não configurado (faltam variáveis de ambiente)' });
    if (password !== process.env.ADMIN_PASSWORD)
      return res.status(401).json({ error: 'senha incorreta' });

    if (action === 'list') {
      const { arr } = await getData();
      return res.status(200).json({ ok: true, products: arr });
    }

    if (action === 'save') {
      const p = body.product || {};
      const { arr, sha } = await getData();
      const idx = p.id ? arr.findIndex(x => x.id === p.id) : -1;
      const isNew = idx === -1;
      const ref = isNew ? nextRef(arr, p.cat) : p.id;

      const newUrls = await uploadImages(body.newImages, ref);
      const keep = Array.isArray(p.imgs) ? p.imgs : [];
      const imgs = [...keep, ...newUrls];
      if (imgs.length === 0) return res.status(400).json({ error: 'adicione pelo menos uma foto' });

      const prod = {
        id: ref,
        code: String(p.code || '').trim() || ref,
        cat: p.cat,
        name: String(p.name || '').trim(),
        material: p.material || 'dourado',
        materialLabel: String(p.materialLabel || '').trim() || 'Dourado',
        price: Number(p.price) || 0,
        specs: String(p.specs || '').trim(),
        imgs,
        featured: !!p.featured,
        gift: !!p.gift,
        visible: p.visible !== false,
      };
      if (!prod.name) return res.status(400).json({ error: 'informe o nome da peça' });
      if (!PREFIX[prod.cat]) return res.status(400).json({ error: 'categoria inválida' });

      if (isNew) arr.push(prod); else arr[idx] = prod;
      await putData(arr, sha, `${isNew ? 'add' : 'edit'}: ${prod.id} ${prod.name}`);
      return res.status(200).json({ ok: true, product: prod });
    }

    if (action === 'delete') {
      const { id } = body;
      const { arr, sha } = await getData();
      const next = arr.filter(x => x.id !== id);
      if (next.length === arr.length) return res.status(404).json({ error: 'produto não encontrado' });
      await putData(next, sha, `del: ${id}`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'toggle') {
      const { id, visible } = body;
      const { arr, sha } = await getData();
      const it = arr.find(x => x.id === id);
      if (!it) return res.status(404).json({ error: 'produto não encontrado' });
      it.visible = !!visible;
      await putData(arr, sha, `${visible ? 'mostra' : 'oculta'}: ${id}`);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'ação desconhecida' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
