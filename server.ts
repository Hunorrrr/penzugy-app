import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

app.use(express.json({ limit: '25mb' }));

// Healthcheck endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Gemini Receipt Scanner endpoint
app.post('/api/scan-receipt', async (req, res) => {
  try {
    const { imageBase64, mimeType = 'image/jpeg' } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Nincs megadva képadat (imageBase64 szükséges)' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'A GEMINI_API_KEY nincs beállítva a szerveren. Kérlek állítsd be az AI Studio Secrets panelen.',
      });
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: imageBase64,
              },
            },
            {
              text: `Feladatod egy magyar vásárlási blokk vagy számla pontos elemzése.
Olvasd ki a következő adatokat és válaszolj KIZÁRÓLAG egy érvényes JSON formátumban:
{
  "amount": <a számla/blokk végösszege magyar forintban számként kerekítve, pl. 4850>,
  "merchant": "<az üzlet vagy cég neve, pl. SPAR, McDonald's, MOL, dm, Rossmann>",
  "category": "<KIZÁRÓLAG vagy 'szórakozás' vagy 'hasznos'. Szabály: Ha napi élelmiszer, gyógyszer, tankolás, kötelező háztartási cikk -> 'hasznos'. Ha gyorsétterem, kávézó, pub, alkohol, mozi, játék, hobbicikk -> 'szórakozás'>",
  "itemsSummary": "<rövid 1-2 mondatos összefoglaló a vásárolt dolgokról>"
}
Csak és kizárólag a JSON objektumot küldd vissza, markdown kódblokk nélkül.`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text || '{}';
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Clean possible markdown code fence
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleaned);
    }

    return res.json({
      success: true,
      amount: typeof parsed.amount === 'number' ? parsed.amount : parseInt(parsed.amount, 10) || 0,
      merchant: parsed.merchant || 'Bolt / Vásárlás',
      category: parsed.category === 'szórakozás' ? 'szórakozás' : 'hasznos',
      itemsSummary: parsed.itemsSummary || '',
    });
  } catch (error: any) {
    console.error('Error scanning receipt:', error);
    return res.status(500).json({
      error: error.message || 'Sikertelen blokk-felismerés. Kérlek próbáld újra egy tisztább fotóval.',
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });
}

startServer();
