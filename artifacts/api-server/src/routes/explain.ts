import { Router, type IRouter } from "express";

const router: IRouter = Router();

type ExplainMode = "full" | "revision" | "osce";

async function getOpenAIClient() {
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("AI explanation is not configured yet.");
  }
  const { openai } = await import("@workspace/integrations-openai-ai-server");
  return openai;
}

function buildPrompts(mode: ExplainMode, front: string, back: string): { system: string; user: string; maxTokens: number } {
  const topic = `${front}: ${back}`;

  if (mode === "full") {
    return {
      maxTokens: 16000,
      system: `Act as a senior physician, medical professor, and clinical educator.

Your response must be:
1. Scientifically rigorous (medical-school / postgraduate level)
2. Structured and comprehensive
3. Clinically relevant

When explaining a topic derived from a flashcard, include as many of the following sections as are relevant:

1. Definition  
2. Epidemiology  
3. Etiology & Risk Factors  
4. Pathophysiology (step-by-step mechanism)  
5. Gross and microscopic pathology (if applicable)  
6. Clinical presentation (signs & symptoms)  
7. Red flags / complications  
8. Differential diagnosis (with distinguishing features)  
9. Diagnostic approach:
   - Labs
   - Imaging
   - Gold standard test
10. Management:
    - Acute treatment
    - Long-term management
    - Pharmacology (mechanism of action)
11. Prognosis  
12. High-yield exam pearls
13. Image prompts: For each diagram or illustration described, also generate a detailed AI image generation prompt suitable for DALL·E or Midjourney.

VISUALS:
- Add labeled diagrams (flowcharts, anatomical illustrations, or mechanisms)
- Use simple ASCII diagrams or describe medical illustrations clearly

STYLE:
- Use bullet points + short paragraphs
- Use **bold** for key terms
- Make it suitable for medical students and doctors

OPTIONAL (include if relevant):
- Add a brief clinical case at the end
- Compare with closely related diseases`,
      user: `Explain the topic: ${topic}`,
    };
  }

  if (mode === "revision") {
    return {
      maxTokens: 8192,
      system: `Act as a senior medical educator. Your task is to create a concise, high-yield 1-page revision sheet.

FORMAT:
- Use a clean, scannable layout
- Sections: Key Facts | Pathophysiology | Clinical Features | Investigations | Management | Pearls & Pitfalls
- Use bullet points and short phrases — no long paragraphs
- Use **bold** for the most important terms
- Include a mini mnemonic or memory aid if relevant
- The entire output should fit on one printed A4 page — be ruthlessly concise
- End with 3–5 high-yield exam bullet points labelled "⚡ EXAM PEARLS"

STYLE: Concise, structured, exam-ready.`,
      user: `Create a 1-page revision sheet for: ${topic}`,
    };
  }

  // osce
  return {
    maxTokens: 8192,
    system: `Act as a senior OSCE examiner and clinical educator. Generate realistic OSCE (Objective Structured Clinical Examination) questions.

For each station include:
- **Station type** (e.g., History Taking, Physical Examination, Data Interpretation, Communication, Practical Skill)
- **Scenario / stem** — realistic patient vignette (name, age, presenting complaint, context)
- **Candidate instructions** (what the student must do in the station)
- **Examiner mark scheme** — 8–12 bullet points of expected actions/answers
- **Common mistakes** candidates make
- **Key clinical teaching point**

Generate 3–5 varied OSCE stations covering different aspects of the topic.

STYLE:
- Realistic and clinically accurate
- Appropriate for final-year medical students or junior doctors
- Use **bold** for station type and key terms`,
    user: `Create OSCE stations for the topic: ${topic}`,
  };
}

router.post("/explain", async (req, res): Promise<void> => {
  const { front, back, mode = "full" } = req.body as { front?: string; back?: string; mode?: ExplainMode };

  if (!front || !back) {
    res.status(400).json({ error: "front and back are required." });
    return;
  }

  const validModes: ExplainMode[] = ["full", "revision", "osce"];
  const resolvedMode: ExplainMode = validModes.includes(mode as ExplainMode) ? (mode as ExplainMode) : "full";

  const { system: systemPrompt, user: userPrompt, maxTokens } = buildPrompts(resolvedMode, front, back);

  let openai;
  try {
    openai = await getOpenAIClient();
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "AI not configured." });
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Content-Type-Options", "nosniff");

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      max_completion_tokens: maxTokens,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) res.write(text);
    }
    res.end();
  } catch (err) {
    req.log.error({ err }, "AI explanation failed");
    if (!res.headersSent) {
      res.status(503).json({ error: "AI explanation failed." });
    } else {
      res.end();
    }
  }
});

export default router;
