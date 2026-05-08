import { GoogleGenAI, Type } from '@google/genai';

// We fallback gracefully if the API key isn't set yet during the pilot phase.
export async function computeSeverityLLM(params: {
    title: string;
    description: string;
    type: string;
    createdAt: Date;
    existingVerifiedByAuthorCount: number;
}): Promise<{ severity: number; confidence: number }> {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.warn("GEMINI_API_KEY not set. Falling back to heuristic severity scoring.");
            return fallbackComputeSeverity(params);
        }

        const ai = new GoogleGenAI({ apiKey });

        const prompt = `You are a crime intelligence analyst scoring an incident report for severity.
Incident Type: ${params.type}
Title: ${params.title}
Description: ${params.description}
Reported At: ${params.createdAt.toISOString()}
Author's Prior Verified Reports: ${params.existingVerifiedByAuthorCount}

Please output a JSON object with:
- "severity": an integer between 1 and 10 representing the severity of the crime (10 is most severe, e.g. acute violence or terrorism. 1 is very minor, e.g. noise complaint).
- "confidence": a float between 0.0 and 1.0 representing your confidence in this score based on the details provided.
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        severity: { type: Type.INTEGER },
                        confidence: { type: Type.NUMBER }
                    },
                    required: ["severity", "confidence"]
                }
            }
        });

        const json = JSON.parse(response.text || '{}');
        const severity = typeof json.severity === 'number' ? Math.max(1, Math.min(10, Math.round(json.severity))) : fallbackComputeSeverity(params).severity;
        const confidence = typeof json.confidence === 'number' ? Math.max(0, Math.min(1, json.confidence)) : 0.5;

        return { severity, confidence };
    } catch (error: any) {
        console.error("LLM Severity computation failed:", error.message);
        return fallbackComputeSeverity(params);
    }
}

const fallbackComputeSeverity = (params: any) => {
    const baseByType: Record<string, number> = {
        ARMED_ROBBERY: 9, VEHICLE_CRIME: 6, VANDALISM: 3, ASSAULT: 8, THEFT: 5, OTHER: 4,
    };
    const base = baseByType[params.type] ?? 4;
    const hour = params.createdAt.getHours();
    const nightBoost = hour >= 19 || hour <= 5 ? 1 : 0;
    const repeatBoost = Math.min(2, Math.floor(params.existingVerifiedByAuthorCount / 3));
    const severity = Math.max(1, Math.min(10, Math.round(base + nightBoost + repeatBoost)));

    return { severity, confidence: 0.5 };
};
