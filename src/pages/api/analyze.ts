import type { APIRoute } from "astro";
import { Buffer } from "buffer";

export const prerender = false;

const OPENROUTER_MODEL = "openrouter/free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface CvResult {
  fileName: string;
  candidateName: string;
  score: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendation: string;
}

function buildPrompt(companyDescription: string) {
  return `Eres un reclutador experto. Evalúa el CV adjunto (en PDF) para un puesto en la siguiente empresa:

"""
${companyDescription}
"""

Responde ÚNICAMENTE con un objeto JSON válido (sin markdown, sin texto adicional) con esta forma exacta:
{
  "candidateName": string, // nombre del candidato extraído del CV, o "Candidato" si no se encuentra
  "score": number, // puntuación de 0 a 100 sobre qué tan bien encaja el candidato con la empresa y el puesto descrito
  "summary": string, // resumen de 2-3 frases sobre el candidato y su encaje
  "strengths": string[], // 2-4 puntos fuertes relevantes para esta empresa
  "weaknesses": string[], // 2-4 puntos débiles o riesgos relevantes para esta empresa
  "recommendation": string // una de: "Fuertemente recomendado", "Recomendado", "Con reservas", "No recomendado"
}`;
}

async function analyzeFile(
  file: File,
  companyDescription: string,
  apiKey: string,
): Promise<CvResult> {
  const buffer = await file.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt(companyDescription) },
            {
              type: "file",
              file: {
                filename: file.name,
                file_data: `data:application/pdf;base64,${base64}`,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenRouter respondió ${response.status} para ${file.name}: ${errorText}`,
    );
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error(`Respuesta inesperada de OpenRouter para ${file.name}`);
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `No se pudo extraer JSON de la respuesta para ${file.name}`,
    );
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    fileName: file.name,
    candidateName: String(parsed.candidateName ?? "Candidato"),
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    summary: String(parsed.summary ?? ""),
    strengths: Array.isArray(parsed.strengths)
      ? parsed.strengths.map(String)
      : [],
    weaknesses: Array.isArray(parsed.weaknesses)
      ? parsed.weaknesses.map(String)
      : [],
    recommendation: String(parsed.recommendation ?? "Con reservas"),
  };
}

export const POST: APIRoute = async ({ request }) => {
  const apiKey = import.meta.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "Falta configurar OPENROUTER_API_KEY en el servidor.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const formData = await request.formData();
  const companyDescription = String(
    formData.get("companyDescription") ?? "",
  ).trim();
  const files = formData
    .getAll("cvs")
    .filter((f): f is File => f instanceof File);

  if (!companyDescription) {
    return new Response(
      JSON.stringify({
        error: "Describe la empresa antes de analizar los CVs.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (files.length === 0) {
    return new Response(
      JSON.stringify({ error: "No se recibieron archivos PDF." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const settled = await Promise.allSettled(
    files.map((file) => analyzeFile(file, companyDescription, apiKey)),
  );

  const results: CvResult[] = [];
  const errors: string[] = [];

  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      errors.push(
        `${files[index].name}: ${outcome.reason?.message ?? "error desconocido"}`,
      );
    }
  });

  results.sort((a, b) => b.score - a.score);

  return new Response(JSON.stringify({ companyDescription, results, errors }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
