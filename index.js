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
  model: "gemini-1.5-flash",
  systemInstruction: `
    Bạn là nhân viên tư vấn của doanh nghiệp "Bong Media - Chụp ảnh kỷ yếu" (hoạt động chủ yếu ở Hải Phòng).
    Khách hàng là học sinh cấp 3, sinh viên Gen Z. Xưng hô: "Bong / Tụi mình / Admin" và "Cậu / Các bạn / Lớp mình". Dùng emoji thân thiện.
    
    MỤC TIÊU:
    1. Tư vấn các concept chụp ảnh (Châu Âu, Vintage, Party Night...).
    2. Nêu bật ưu điểm: Đội ngũ thợ ảnh siêu đông, nhiệt tình. Chất lượng hình ảnh sắc nét, trong veo nhờ đầu tư 100% thiết bị cao cấp như body Canon R6 Mark II và các dòng lens L chuẩn mực.
    3. Không gửi bảng giá dài, chỉ báo giá mồi (300k-600k/người trọn gói).
    4. Khéo léo hỏi xin các thông tin: Số điện thoại, Tên trường/lớp, Sĩ số, Concept yêu thích để chốt lịch.
    
    QUY TẮC BẮT BUỘC:
    Mọi câu trả lời của bạn PHẢI là một file JSON hợp lệ duy nhất. KHÔNG có văn bản nào nằm ngoài JSON. Cấu trúc:
    {
      "reply": "Nội dung chat với khách (ngắn gọn 3-4 dòng, thân thiện)",
      "data": {
         "phone": "Số điện thoại khách (nếu có, nếu không để null)",
         "school_class": "Tên lớp/trường (nếu có, nếu không để null)",
         "student_count": "Sĩ số (nếu có, nếu không để null)",
         "concept": "Concept muốn chụp (nếu có, nếu không để null)"
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
      'Concept yêu thích': customerData.concept || ''
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

// Route Verify Webhook
app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Route xử lý tin nhắn
app.post('/webhook', async (req, res) => {
  let body = req.body;
  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      let webhook_event = entry.messaging[0];
      if (!webhook_event || !webhook_event.message || !webhook_event.message.text || webhook_event.message.is_echo) continue;

      let sender_psid = webhook_event.sender.id;
      const userMessage = webhook_event.message.text;
      
      try {
        const result = await model.generateContent(userMessage);
        let text = result.response.text();
        
        // Làm sạch JSON
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiResponse = JSON.parse(text);

        if (aiResponse.reply) {
            await sendFacebookMessage(sender_psid, aiResponse.reply);
        }

        const data = aiResponse.data;
        if (data && (data.phone !== null || data.school_class !== null || data.student_count !== null || data.concept !== null)) {
            // Chỉ lưu khi AI bóc tách được ít nhất 1 trường thông tin
            await saveCustomerData(sender_psid, data);
        }
      } catch (error) {
        console.error("Lỗi hệ thống hoặc parse JSON:", error);
      }
    }
  } else {
    res.sendStatus(404);
  }
});
app.get('/', (req, res) => {
  res.status(200).send('Máy chủ AI của doanh nghiệp Bống Media đang hoạt động bình thường! 🚀');
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy trên port ${PORT}`));
