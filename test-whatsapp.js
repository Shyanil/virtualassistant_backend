require('dotenv').config();
const axios = require('axios');

async function testWhatsApp() {
  const authKey = process.env.MSG91_AUTH_KEY || '504239Adrv9IdB969cd54a8P1';
  const integratedNumber = process.env.MSG91_WHATSAPP_NUMBER || '919073557987';
  const testRecipient = '919073557987'; // Sending to self for test

  console.log('🧪 Starting WhatsApp Integration Test...');
  console.log(`🔑 AuthKey: ${authKey.substring(0, 5)}...`);
  console.log(`📱 Integrated Number: ${integratedNumber}`);

  const payload = {
    integrated_number: integratedNumber,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: "meeting_confirmation",
        language: { code: "en", policy: "deterministic" },
        to_and_components: [{
          to: [testRecipient],
          components: {
            header_1: { type: "image", value: "https://i.ibb.co/vzYpYqY/meeting-confirm.png" },
            body_1: { type: "text", value: "Test User" },
            body_2: { type: "text", value: "AI Assistant" },
            body_3: { type: "text", value: "2026-04-01" },
            body_4: { type: "text", value: "10:00 AM" },
            body_5: { type: "text", value: "https://meet.google.com/test-link" }
          }
        }]
      }
    }
  };

  try {
    const response = await axios.post('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', payload, {
      headers: { 'authkey': authKey, 'Content-Type': 'application/json' }
    });
    console.log('✅ Success! MSG91 Response:', response.data);
  } catch (err) {
    console.error('❌ Failed! MSG91 Error:', err.response?.data || err.message);
    if (err.response?.status === 401) {
      console.error('💡 Tip: Your authkey might be invalid or restricted.');
    }
  }
}

testWhatsApp();
