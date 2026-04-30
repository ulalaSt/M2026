import { Schema } from './schema';

export type TranscribeResult = {
  text: string;
  avgLogprob?: number;
};

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

function buildPrompt(schema: Schema): string {
  const schools = schema.schools.slice(0, 12).join(', ');
  const colors = schema.colors.join(', ');
  const sizes = schema.sizes.join(', ');
  const kinds = schema.kinds.join(', ');
  return `Прокат мантий. Школы: ${schools}. Цвета: ${colors}. Размеры: ${sizes}. Виды: ${kinds}. Команды содержат номера телефонов и даты.`;
}

export async function transcribeAudio(
  groqKey: string,
  audioBuffer: ArrayBuffer,
  schema: Schema,
): Promise<TranscribeResult> {
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
  const form = new FormData();
  form.append('file', blob, 'audio.ogg');
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('prompt', buildPrompt(schema));
  // language НЕ передаём — whisper-v3 хорошо обрабатывает русско-казахский код-свитчинг

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}` },
    body: form,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`[transcribeAudio] Groq ${resp.status}: ${txt.slice(0, 300)}`);
    throw new Error(`Groq ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const json: any = await resp.json();
  const text = (json.text ?? '').trim();
  const segments: any[] = json.segments ?? [];
  let avgLogprob: number | undefined;
  if (segments.length) {
    const sum = segments.reduce((s, x) => s + (typeof x.avg_logprob === 'number' ? x.avg_logprob : 0), 0);
    avgLogprob = sum / segments.length;
  }
  return { text, avgLogprob };
}

export const LOW_CONFIDENCE_THRESHOLD = -0.7;
