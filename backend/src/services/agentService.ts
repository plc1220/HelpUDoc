import axios from "axios";

const AGENT_URL = process.env.AGENT_URL || "http://localhost:8001";

export async function chatWithAgent(workspace: string, message: string) {
  const res = await axios.post(`${AGENT_URL}/workspace/${workspace}/chat`, { message });
  return res.data;
}

export async function uploadToAgent(workspace: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await axios.post(`${AGENT_URL}/workspace/${workspace}/upload`, form);
  return res.data;
}