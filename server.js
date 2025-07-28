

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 5001;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const allowedOrigins = [
  'https://drug-app-frontend.vercel.app', // あなたのVercelフロントエンドのURL
  // 開発用にlocalhostも許可する場合は以下を追加
  // 'http://localhost:3000',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true // 必要に応じて追加
}));
app.use(express.json({ limit: '50mb' })); // Increase limit for image uploads

// Converts a File object to a GoogleGenerativeAI.Part object.
function fileToGenerativePart(base64EncodedImage, mimeType) {
  return {
    inlineData: {
      data: base64EncodedImage,
      mimeType
    },
  };
}

app.post('/api/identify', async (req, res) => {
  try {
    const { imageData, mimeType } = req.body;

    if (!imageData || !mimeType) {
      return res.status(400).json({ error: '画像データとMIMEタイプが必要です。' });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const prompt = "この画像に写っている薬剤の名称と数量を特定してください。識別が困難な場合はその旨を伝えてください。例：アセトアミノフェン 2錠";

    const imagePart = fileToGenerativePart(imageData, mimeType);

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();

    // Simple parsing for demonstration. In a real app, you'd need more robust parsing.
    const identifiedDrugs = [];
    const lines = text.split('\n');
    lines.forEach(line => {
      const match = line.match(/(.+?)\s+(\d+)(錠|カプセル|ml|個)/);
      if (match) {
        identifiedDrugs.push({ name: match[1], quantity: match[2] + match[3] });
      } else if (line.includes("識別が困難")) {
        identifiedDrugs.push({ name: "不明", quantity: "不明", message: line });
      }
    });

    if (identifiedDrugs.length === 0) {
      identifiedDrugs.push({ name: "不明", quantity: "不明", message: "薬剤の識別ができませんでした。" });
    }

    res.json({ identifiedDrugs, rawResponse: text });
  } catch (error) {
    console.error('Error identifying drug:', error);
    res.status(500).json({ error: '薬剤の識別中にエラーが発生しました。' });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { identifiedDrugs, prescriptionImageData, prescriptionMimeType, timing } = req.body;

    if (!identifiedDrugs || !prescriptionImageData || !prescriptionMimeType || !timing) {
      return res.status(400).json({ error: '必要な情報が不足しています。' });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const prescriptionImagePart = fileToGenerativePart(prescriptionImageData, prescriptionMimeType);

    const prompt = `以下の薬剤リストと処方箋の画像を照合し、必ず下記のJSON形式で回答してください。

【服用タイミング】
${timing}

【薬剤リスト】
${identifiedDrugs.map(d => `- ${d.name} ${d.quantity}`).join('\n')}

【処方箋から読み取った薬剤】
処方箋の画像を解析し、薬剤名、数量、用法を抽出してください。

【照合結果】
薬剤リストと処方箋の情報を比較し、一致・不一致を判断してください。

【出力フォーマット】
{
  "overallStatus": "完全一致" | "一部不一致" | "不一致",
  "summary": "照合結果の要約（例：処方されたすべての薬剤が確認できました。）",
  "prescriptionDrugs": [
    { "name": "薬剤名", "quantity": "数量", "timing": "用法" }
  ],
  "comparison": [
    {
      "identifiedName": "識別した薬剤名",
      "prescriptionName": "処方箋の薬剤名",
      "match": true | false,
      "warning": "不一致の場合の警告メッセージ"
    }
  ]
}
`;

    const result = await model.generateContent([prompt, prescriptionImagePart]);
    const response = await result.response;
    const text = response.text();

    let parsedData;
    try {
      // Find the JSON part of the response
      const jsonMatch = text.match(/{[\s\S]*}/);
      if (!jsonMatch) {
          throw new Error("AIの応答に有効なJSONオブジェクトが見つかりません。");
      }

      const jsonString = jsonMatch[0];
      const parsedData = JSON.parse(jsonString);

      let overallStatusColor = "gray";
      if (parsedData.overallStatus?.includes("完全一致")) overallStatusColor = "green";
      else if (parsedData.overallStatus?.includes("一部不一致")) overallStatusColor = "yellow";
      else if (parsedData.overallStatus?.includes("不一致")) overallStatusColor = "red";

      res.json({
        ...parsedData,
        overallStatusColor,
        identifiedDrugs, // Re-use identifiedDrugs from request for display
        rawResponse: text,
      });

    } catch (parseError) {
      console.error("Failed to parse Gemini response as JSON:", parseError);
      console.error("Raw Gemini Response:", text); // Log the raw response for debugging
      res.status(500).json({
          error: 'AIからの応答を解析できませんでした。形式が正しくない可能性があります。',
          rawResponse: text // Send raw response to frontend for debugging
      });
    }
  } catch (error) {
    console.error('Error verifying prescription:', error);
    res.status(500).json({ error: '処方箋の照合中にエラーが発生しました。' });
  }
});

app.post('/api/drug-info', async (req, res) => {
  try {
    const { drugName } = req.body;
    if (!drugName) {
      return res.status(400).json({ error: '薬剤名が必要です。' });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const prompt = `${drugName}という医薬品について、以下の情報を一般の方向けに分かりやすく、簡潔にまとめてください。\n\n- 主な効能・効果\n- 考えられる主な副作用\n- 服用時の注意点\n\n回答は箇条書きで、マークダウン形式でお願いします。`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({ details: text });

  } catch (error) {
    console.error('Error fetching drug info:', error);
    res.status(500).json({ error: '薬剤情報の取得中にエラーが発生しました。' });
  }
});

app.listen(port, () => {
  console.log(`Backend server listening at http://localhost:${port}`);
});
