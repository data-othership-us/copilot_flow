import axios from "axios";
import { config } from "../../config.js";

const client = axios.create({
  baseURL: config.mt.baseUrl,
  headers: {
    Authorization: `Bearer ${config.mt.apiKey}`,
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
  },
  timeout: 30000,
});

function cleanPath(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

function asMessage(error) {
  return error?.response?.data ?? error?.message ?? "Unknown error";
}

async function request(method, path, data, params) {
  try {
    const response = await client.request({
      method,
      url: cleanPath(path),
      data,
      params,
    });
    return response.data;
  } catch (error) {
    const wrapped = new Error(
      `MarianaTek ${method.toUpperCase()} ${path} failed: ${JSON.stringify(asMessage(error))}`,
    );
    wrapped.status = error?.response?.status ?? 500;
    wrapped.meta = error?.response?.data ?? null;
    throw wrapped;
  }
}

export async function mtGet(path, params) {
  return request("get", path, undefined, params);
}

export async function mtPost(path, data, params) {
  return request("post", path, data, params);
}

export async function mtPatch(path, data, params) {
  return request("patch", path, data, params);
}
