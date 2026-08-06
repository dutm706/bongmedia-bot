const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Khởi tạo Gemini với yêu cầu xuất JSON
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-flash-latest",
// ...
  systemInstruction: `
    Bạn là nhân viên tư vấn của doanh nghiệp "Bống Media - Chụp ảnh kỷ yếu" (hoạt động chủ yếu ở Hải Dương - Hải Phòng).
    Khách hàng là học sinh cấp 3, sinh viên Gen Z. Xưng hô: "Bống / Tụi mình / Admin" và "Cậu / Các bạn / Lớp mình". Dùng emoji thân thiện.
    
    MỤC TIÊU & QUY TẮC CHỐNG LẶP (CỰC KỲ QUAN TRỌNG):
    1. Ghi nhớ ngữ cảnh: Bạn đã có trí nhớ. Hãy đọc kỹ lịch sử trò chuyện. TUYỆT ĐỐI KHÔNG HỎI LẠI những thông tin mà khách đã cung cấp (SĐT, trường lớp, sĩ số, concept, ngày chụp).
    2. Chống lặp văn mẫu: Chỉ chào hỏi và khoe thiết bị (Canon R6 Mark II, lens L) ở TIN NHẮN ĐẦU TIÊN. Tuyệt đối không nhắc lại điệp khúc thiết bị này ở các câu sau gây phản cảm cho khách.
    3. Trọng tâm: Tư vấn concept, báo giá mồi (300k-600k/người) và chỉ khéo léo hỏi thăm những thông tin CÒN THIẾU để chốt lịch. Trả lời ngắn gọn, tự nhiên như người thật.
    
    QUY TẮC BẮT BUỘC:
    Mọi câu trả lời của bạn PHẢI là một file JSON hợp lệ duy nhất. KHÔNG có văn bản nào nằm ngoài JSON. Cấu trúc:
    {
      "reply": "Nội dung chat với khách (ngắn gọn, tự nhiên, không nhai lại ý cũ)",
      "data": {
         "phone": "Số điện thoại (nếu có, nếu không để null)",
         "school_class": "Tên lớp/trường (nếu có, nếu không để null)",
         "student_count": "Sĩ số (nếu có, nếu không để null)",
         "concept": "Concept muốn chụp (nếu có, nếu không để null)",
         "shoot_date": "Ngày chụp dự kiến (nếu có, nếu không để null)"
      }
    }
  `
});

// Cấu hình Google Sheets
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Hàm lưu data chắt lọc
async function saveCustomerData(senderId, customerData) {
  try {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0]; 
    
    await sheet.addRow({
      'Thời gian': new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      'Facebook ID': senderId,
      'Số điện thoại': customerData.phone || '',
      'Trường / Tên lớp': customerData.school_class || '',
      'Sĩ số dự kiến': customerData.student_count || '',
      'Concept yêu thích': customerData.concept || '',
      'Ngày chụp dự kiến': customerData.shoot_date || ''
    });
  } catch (error) {
    console.error("Lỗi Google Sheet:", error);
  }
}

// Hàm gửi tin nhắn Messenger
async function sendFacebookMessage(senderId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      messaging_type: "RESPONSE",
      message: { text: text }
    });
  } catch (error) {
    console.error("Lỗi gửi tin nhắn FB:", error.response?.data || error.message);
  }
}
// Thêm dòng này để khởi tạo bộ nhớ cho AI (đặt ở phạm vi toàn cục)
const chatSessions = {}; 

// ... (code hiện tại của bạn)
app.post('/webhook', async (req, res) => {
    // ...
// Route Verify Webhook
app.post('/webhook', async (req, res) => {
  let body = req.body;
  if (body.object === 'page') {
    
    for (const entry of body.entry) {
      let webhook_event = entry.messaging[0];
      if (!webhook_event || !webhook_event.message || !webhook_event.message.text || webhook_event.message.is_echo) continue;

      let sender_psid = webhook_event.sender.id;
      const userMessage = webhook_event.message.text;
      
      try {
        // KIỂM TRA TRÍ NHỚ: Nếu khách này chưa từng chat, tạo một phiên chat mới
        if (!chatSessions[sender_psid]) {
          chatSessions[sender_psid] = model.startChat({
            history: [],
          });
        }

        // Gọi phiên chat của đúng khách hàng đó và gửi tin nhắn mới
        const chat = chatSessions[sender_psid];
        const result = await chat.sendMessage(userMessage);
        
        let text = result.response.text();
        
        // Làm sạch JSON
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiResponse = JSON.parse(text);

        // Đợi gửi tin nhắn cho khách
        if (aiResponse.reply) {
            await sendFacebookMessage(sender_psid, aiResponse.reply);
        }

        // Đợi lưu dữ liệu vào Google Sheet
        const data = aiResponse.data;
        if (data && (data.phone !== null || data.school_class !== null || data.student_count !== null || data.concept !== null || data.shoot_date !== null)) {
            await saveCustomerData(sender_psid, data);
        }
      } catch (error) {
        console.error("Lỗi hệ thống hoặc parse JSON:", error);
      }
    }

    res.status(200).send('EVENT_RECEIVED');

  } else {
    res.sendStatus(404);
  }
});
app.get('/', (req, res) => {
  res.status(200).send('Máy chủ AI của doanh nghiệp Bống Media đang hoạt động bình thường! 🚀');
});
app.get('/test-models', async (req, res) => {
  try {
    const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    const availableModels = response.data.models
      .filter(m => m.supportedGenerationMethods.includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
    res.json({ count: availableModels.length, models: availableModels });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy trên port ${PORT}`));
