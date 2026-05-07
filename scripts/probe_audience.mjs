import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const { API_BASE_URL, ADMIN_API_KEY, INGEST_EMAIL, INGEST_PASSWORD } = process.env;
const TARGET_EMAIL = "kevin.coelho@gmail.com";
const BOATS = [
  { name: "El Dorado", id: 104 },
  { name: "El Patron", id: 178 },
  { name: "Black Pearl", id: 244 }
];

const headers = { "Content-Type": "application/json", "x-admin-api-key": ADMIN_API_KEY };

async function login() {
  const r = await axios.post(`${API_BASE_URL}/api/admin/login`,
    { email: INGEST_EMAIL, password: INGEST_PASSWORD },
    { timeout: 15000, headers });
  return r.data?.data?.token;
}

async function getMembers(token, boatId) {
  const all = [];
  let page = 1;
  let lastMeta = null;
  while (true) {
    const r = await axios.get(`${API_BASE_URL}/api/v1/audience/members`, {
      params: { partner_type: "boat", partner_id: boatId, page, page_size: 200 },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });
    const d = r.data?.data || {};
    const members = d.members || [];
    lastMeta = { total: d.total, page: d.page, page_size: d.page_size, has_more: d.has_more, returned: members.length };
    all.push(...members);
    const apparentSize = members.length;
    if (apparentSize === 0) break;
    // Stop if we've collected total or backend says no more
    if (d.has_more === false) break;
    if (d.total != null && all.length >= d.total) break;
    page++;
    if (page > 50) break;
  }
  return { members: all, lastMeta };
}

(async () => {
  const token = await login();
  const target = TARGET_EMAIL.toLowerCase();

  for (const b of BOATS) {
    const { members, lastMeta } = await getMembers(token, b.id);
    const match = members.find(m => (m.email || "").toLowerCase() === target);
    console.log(`\n=== ${b.name} (boat_id=${b.id}) — collected ${members.length} members (last page meta: ${JSON.stringify(lastMeta)}) ===`);
    if (match) {
      console.log(`  ✓ FOUND ${TARGET_EMAIL}`);
      console.log(`    user_id=${match.user_id}, name="${match.name}", push_enabled=${match.push_enabled}`);
      console.log(`    full record:`, JSON.stringify(match, null, 2));
    } else {
      console.log(`  ✗ ${TARGET_EMAIL} NOT in audience`);
      // Show a sample of who IS in there
      const sample = members.slice(0, 5).map(m => `${m.email} (push=${m.push_enabled})`);
      console.log(`  Sample members: ${JSON.stringify(sample, null, 2)}`);
    }
  }
})().catch(e => { console.error("Fatal:", e.response?.data || e.message); process.exit(1); });
