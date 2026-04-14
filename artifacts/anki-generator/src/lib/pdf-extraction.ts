import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ProgressCallback = (message: string) => void;

const MIN_TEXT_LENGTH = 20;
const MAX_OCR_DIMENSION = 2200;
const SERVER_EXTRACT_URL = "/api/extract-pdf";

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function copyBuffer(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer.slice(0));
}

async function loadPdf(buffer: ArrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: copyBuffer(buffer) });
  return loadingTask.promise;
}

async function extractEmbeddedText(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string> {
  const pdf = await loadPdf(buffer);
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onProgress?.(`Extracting page ${pageNumber}/${pdf.numPages}…`);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
        .filter(Boolean)
        .join(" ");
      pageTexts.push(pageText);
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }

  return normalizeText(pageTexts.join("\n"));
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not render PDF page for OCR."));
      }
    }, "image/png");
  });
}

async function extractClientOcrText(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string> {
  const pdf = await loadPdf(buffer);
  const worker = await createWorker("eng");
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onProgress?.(`OCR page ${pageNumber}/${pdf.numPages}…`);
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.max(
        1,
        Math.min(2, MAX_OCR_DIMENSION / Math.max(baseViewport.width, baseViewport.height)),
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Could not prepare OCR canvas.");
      }

      await page.render({ canvasContext: context, canvas, viewport }).promise;
      const image = await canvasToBlob(canvas);
      const { data } = await worker.recognize(image);
      pageTexts.push(data.text);
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await worker.terminate();
    await pdf.destroy();
  }

  return normalizeText(pageTexts.join("\n"));
}

async function extractServerText(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string> {
  onProgress?.("Sending to server for OCR…");
  const response = await fetch(SERVER_EXTRACT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
    },
    body: buffer.slice(0),
  });

  const data = await response.json().catch(() => null) as { text?: unknown; error?: unknown; method?: unknown } | null;

  if (!response.ok) {
    const error = typeof data?.error === "string" ? data.error : "Server PDF extraction failed.";
    throw new Error(error);
  }

  if (!data || typeof data.text !== "string" || data.text.trim().length <= MIN_TEXT_LENGTH) {
    throw new Error("No readable text found in this PDF.");
  }

  return normalizeText(data.text);
}

export async function extractPdfText(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string> {
  let embeddedText = "";

  try {
    embeddedText = await extractEmbeddedText(buffer, onProgress);
  } catch {
    try {
      return await extractServerText(buffer, onProgress);
    } catch (fallbackError) {
      throw fallbackError instanceof Error
        ? fallbackError
        : new Error("PDF extraction failed in this browser.");
    }
  }

  if (embeddedText.length > MIN_TEXT_LENGTH) {
    return embeddedText;
  }

  onProgress?.("Scanned PDF detected — running server OCR…");

  try {
    return await extractServerText(buffer, onProgress);
  } catch (serverError) {
    onProgress?.("Server OCR unavailable, trying local OCR…");
    try {
      const ocrText = await extractClientOcrText(buffer, onProgress);
      if (ocrText.length > MIN_TEXT_LENGTH) {
        return ocrText;
      }
    } catch {
      // swallow — throw the server error below
    }
    throw serverError instanceof Error
      ? serverError
      : new Error("No readable text found in this PDF.");
  }
}

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function isTextFile(file: File): boolean {
  return file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");
}
