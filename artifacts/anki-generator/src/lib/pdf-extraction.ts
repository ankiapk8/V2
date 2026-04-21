import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";
import { apiUrl } from "@/lib/utils";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ProgressCallback = (message: string) => void;

const MIN_TEXT_LENGTH = 20;
const MAX_OCR_DIMENSION = 2200;
const SERVER_EXTRACT_URL = apiUrl("api/extract-pdf");
const CLIENT_MAX_PAGES = Number.MAX_SAFE_INTEGER;
const SERVER_THRESHOLD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PAGES = Number.MAX_SAFE_INTEGER;
const IMAGE_WIDTH = 1100;
const IMAGE_QUALITY = 0.85;

export interface PdfExtractionResult {
  text: string;
  pageImages: string[];
}

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

async function renderPageToJpeg(
  pdf: Awaited<ReturnType<typeof loadPdf>>,
  pageNumber: number,
): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = IMAGE_WIDTH / baseViewport.width;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");

  if (!context) throw new Error("Could not get canvas context for image extraction.");

  await page.render({ canvasContext: context, canvas, viewport }).promise;
  page.cleanup();

  return new Promise<string>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error("Failed to render page image.")); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read page image."));
        reader.readAsDataURL(blob);
        canvas.width = 0;
        canvas.height = 0;
      },
      "image/jpeg",
      IMAGE_QUALITY,
    );
  });
}

async function extractEmbeddedText(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string> {
  const pdf = await loadPdf(buffer);
  const pageTexts: string[] = [];
  const pagesToProcess = Math.min(pdf.numPages, CLIENT_MAX_PAGES);

  try {
    for (let pageNumber = 1; pageNumber <= pagesToProcess; pageNumber++) {
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

async function extractPageImages(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<string[]> {
  const pdf = await loadPdf(buffer);
  const images: string[] = [];
  const pagesToRender = Math.min(pdf.numPages, MAX_IMAGE_PAGES);

  try {
    for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber++) {
      onProgress?.(`Capturing page ${pageNumber}/${pagesToRender} image…`);
      try {
        const dataUrl = await renderPageToJpeg(pdf, pageNumber);
        images.push(dataUrl);
      } catch {
        // skip failed page renders
      }
    }
  } finally {
    await pdf.destroy();
  }

  return images;
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
  onProgress?.("Sending to server for extraction…");
  const blob = new Blob([buffer], { type: "application/pdf" });
  const formData = new FormData();
  formData.append("file", blob, "upload.pdf");

  const response = await fetch(SERVER_EXTRACT_URL, {
    method: "POST",
    body: formData,
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
  const result = await extractPdf(buffer, onProgress);
  return result.text;
}

export async function extractPdf(buffer: ArrayBuffer, onProgress?: ProgressCallback): Promise<PdfExtractionResult> {
  const isLargeFile = buffer.byteLength > SERVER_THRESHOLD_BYTES;
  let text = "";

  if (!isLargeFile) {
    let embeddedText = "";

    try {
      embeddedText = await extractEmbeddedText(buffer, onProgress);
    } catch {
      // fall through to server
    }

    if (embeddedText.length > MIN_TEXT_LENGTH) {
      text = embeddedText;
    }
  } else {
    onProgress?.("Large file detected — using server extraction…");
  }

  if (!text) {
    try {
      text = await extractServerText(buffer, onProgress);
    } catch (serverError) {
      if (!isLargeFile) {
        onProgress?.("Server unavailable, trying local OCR…");
        try {
          const ocrText = await extractClientOcrText(buffer, onProgress);
          if (ocrText.length > MIN_TEXT_LENGTH) {
            text = ocrText;
          }
        } catch {
          // swallow
        }
      }
      if (!text) {
        throw serverError instanceof Error
          ? serverError
          : new Error("No readable text found in this PDF.");
      }
    }
  }

  onProgress?.("Capturing page images…");
  let pageImages: string[] = [];
  try {
    pageImages = await extractPageImages(buffer, onProgress);
  } catch {
    // images are best-effort — don't fail the whole extraction
  }

  return { text, pageImages };
}

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function isTextFile(file: File): boolean {
  return file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");
}
