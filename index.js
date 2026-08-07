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
    
    MỤC TIÊU & QUY TẮC TƯ VẤN (CỰC KỲ QUAN TRỌNG):
    1. Phân loại Booking đầu vào: Ngay khi khách hàng nhắn tin lần đầu, bạn BẮT BUỘC phải chào hỏi và hỏi họ muốn chụp theo hình thức nào (Cá nhân, Nhóm bạn, hay Lớp) bằng cách đưa ra 3 lựa chọn quick_replies.
    2. Tư vấn theo phễu: 
       - Nếu khách chọn "Cá nhân" / "Nhóm bạn": Tư vấn các concept lẻ (nàng thơ, beauty, vintage, dã ngoại...), báo giá lẻ. Không nhắc đến "sĩ số lớp".
       - Nếu khách chọn "Lớp": Tư vấn concept kỷ yếu tập thể (Party Night, Châu Âu, Thanh xuân...), báo giá trọn gói sĩ số đông (300k-600k/người) và nhấn mạnh thiết bị body Canon R6 Mark II cùng dàn lens L.
       - Nếu khách đổi ý muốn nghe thêm về loại hình booking khác, hãy linh hoạt chuyển đổi nội dung tư vấn ngay lập tức.
    3. Ghi nhớ ngữ cảnh: Đã có trí nhớ. TUYỆT ĐỐI KHÔNG HỎI LẠI những thông tin khách đã cung cấp (Loại booking, SĐT, trường lớp, sĩ số, concept, ngày chụp).
    
    QUY TẮC BẮT BUỘC:
    Mọi câu trả lời của bạn PHẢI là một file JSON hợp lệ duy nhất. KHÔNG có văn bản nào nằm ngoài JSON. Cấu trúc:
    {
      "reply": "Nội dung chat với khách (ngắn gọn, tự nhiên, tập trung vào loại booking khách chọn)",
      "quick_replies": ["Cá nhân", "Nhóm bạn", "Lớp"], // Tạo tối đa 3 lựa chọn trả lời nhanh. Nếu là câu hỏi đầu, BẮT BUỘC trả về ["Cá nhân", "Nhóm bạn", "Lớp"]. Nếu không cần hỏi thêm, để [].
      "data": {
         "booking_type": "Hình thức chụp khách chọn: Cá nhân, Nhóm bạn, hoặc Lớp (nếu có, nếu không để null)",
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
      'Loại Booking': customerData.booking_type || '', // Thêm trường thông tin mới
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
// Hàm gửi tin nhắn qua Messenger API (Hỗ trợ Quick Replies)
async function sendFacebookMessage(sender_psid, text, quickRepliesArray = []) {
  let messageData = {
    text: text
  };

  // Nếu AI có tạo ra nút bấm, thì đóng gói gửi kèm
  if (quickRepliesArray && quickRepliesArray.length > 0) {
    messageData.quick_replies = quickRepliesArray.map(reply => ({
      content_type: "text",
      title: reply.length > 20 ? reply.substring(0, 17) + "..." : reply, // Chống lỗi quá 20 ký tự
      payload: "QUICK_REPLY_PAYLOAD" 
    }));
  }

  const requestBody = {
    recipient: { id: sender_psid },
    message: messageData
  };

  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, requestBody);
  } catch (error) {
    console.error("Lỗi gửi tin nhắn FB:", error.response?.data || error.message);
  }
}
// Bộ nhớ tạm để lưu lịch sử chat của từng khách hàng
const chatSessions = {}; 

app.post('/webhook', async (req, res) => {
  let body = req.body;
  if (body.object === 'page') {
    
    for (const entry of body.entry) {
      let webhook_event = entry.messaging[0];
      if (!webhook_event || !webhook_event.message || !webhook_event.message.text || webhook_event.message.is_echo) continue;

      let sender_psid = webhook_event.sender.id;
      const userMessage = webhook_event.message.text;
      
      try {
        // Kiểm tra trí nhớ
        if (!chatSessions[sender_psid]) {
          chatSessions[sender_psid] = model.startChat({
            history: [],
          });
        }

        // Gọi phiên chat và gửi tin
        const chat = chatSessions[sender_psid];
        const result = await chat.sendMessage(userMessage);
        
        let text = result.response.text();
        
        // Làm sạch JSON
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiResponse = JSON.parse(text);

        // Gửi tin nhắn cho khách (Kèm nút bấm trả lời nhanh)
        if (aiResponse.reply) {
            await sendFacebookMessage(sender_psid, aiResponse.reply, aiResponse.quick_replies);
        }

        // Đợi lưu dữ liệu vào Google Sheet (thêm điều kiện booking_type)
        const data = aiResponse.data;
        if (data && (data.booking_type !== null || data.phone !== null || data.school_class !== null || data.student_count !== null || data.concept !== null || data.shoot_date !== null)) {
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

// Khởi chạy server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bong Media bot is running on port ${PORT}`);
});
