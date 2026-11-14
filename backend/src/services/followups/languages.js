// ============================================================
// FOLLOW-UP LANGUAGES -- the words the system itself speaks and writes.
//
// The owner writes each automation's message in the language they pick;
// around it the system adds fixed lines it must always say: that the call
// is automated and from which gym, the keypad menu (with "press 9 to
// stop"), and what is said after a key press. Those live here, per
// language, with starter messages so an owner never faces a blank box.
//
// English and Hindi were written first-hand; the other languages were
// written carefully but should be read by a native speaker. Owners can
// reword the spoken lines for their gym (followup_settings.lines_json),
// so a phrase that sounds off locally is a settings change, not a release.
//
// Placeholders: {name} {gym} {days_absent} {end_date} {amount_due}.
// Hindi and Punjabi avoid first-person verb forms, which are gendered,
// because the speaking voice can be either.
// ============================================================

/** kind -> the "press 2" meaning: back soon / renewing / paying. */
const KINDS = ['missed_visits', 'membership_ending', 'payment_due'];

const L = {
  en: {
    name: 'English', native: 'English', locale: 'en-IN',
    lines: {
      disclosure: 'This is an automated call from {gym}.',
      press1: 'To talk to us, press 1.',
      press2: {
        missed_visits: "If you'll be back soon, press 2.",
        membership_ending: "If you'll renew, press 2.",
        payment_due: "If you'll pay soon, press 2.",
      },
      press9: 'To stop these calls, press 9.',
      after1: 'Thank you. Someone from {gym} will call you back soon.',
      after2: 'Thank you. See you soon!',
      after9: 'Done. {gym} will not call you again. Goodbye.',
      agentIntro: "Hi {name}! I'm an AI assistant calling from {gym}. Do you have a minute?",
    },
    quick: { callMe: 'Call me', onIt: { missed_visits: "I'll be back", membership_ending: "I'll renew", payment_due: "I'll pay" }, stop: 'Stop messages' },
    starters: {
      missed_visits: "Hi {name}! We haven't seen you at the gym for {days_absent} days, and we miss you. Even a short session this week keeps your progress going. Your trainer is ready when you are.",
      membership_ending: 'Hi {name}! Your membership ends on {end_date}. Renew in time to keep training without a break.',
      payment_due: 'Hi {name}! A payment of {amount_due} for your membership is still pending. Please pay at the front desk or in the app. Thank you!',
    },
  },
  hi: {
    name: 'Hindi', native: 'हिन्दी', locale: 'hi-IN',
    lines: {
      disclosure: 'यह {gym} की ओर से एक ऑटोमेटेड कॉल है।',
      press1: 'हमसे बात करने के लिए 1 दबाएँ।',
      press2: {
        missed_visits: 'अगर आप जल्द वापस आ रहे हैं, तो 2 दबाएँ।',
        membership_ending: 'अगर आप मेंबरशिप रिन्यू करेंगे, तो 2 दबाएँ।',
        payment_due: 'अगर आप जल्द भुगतान करेंगे, तो 2 दबाएँ।',
      },
      press9: 'ये कॉल बंद करने के लिए 9 दबाएँ।',
      after1: 'धन्यवाद। {gym} से कोई आपको जल्द ही कॉल करेगा।',
      after2: 'धन्यवाद। जल्द मिलते हैं!',
      after9: 'ठीक है। {gym} आपको दोबारा कॉल नहीं करेगा। नमस्ते।',
      agentIntro: 'नमस्ते {name}! मैं {gym} की ओर से एक AI असिस्टेंट हूँ। क्या आपके पास एक मिनट है?',
    },
    quick: { callMe: 'मुझे कॉल करें', onIt: { missed_visits: 'जल्द आ रहे हैं', membership_ending: 'रिन्यू करेंगे', payment_due: 'भुगतान करेंगे' }, stop: 'मैसेज बंद करें' },
    starters: {
      missed_visits: 'नमस्ते {name}! आप {days_absent} दिनों से जिम नहीं आए हैं, हमें आपकी कमी महसूस हो रही है। इस हफ़्ते एक छोटा सेशन भी आपकी प्रोग्रेस बनाए रखेगा। आपका ट्रेनर आपका इंतज़ार कर रहा है।',
      membership_ending: 'नमस्ते {name}! आपकी मेंबरशिप {end_date} को ख़त्म हो रही है। बिना रुकावट ट्रेनिंग जारी रखने के लिए समय पर रिन्यू करें।',
      payment_due: 'नमस्ते {name}! आपकी मेंबरशिप का {amount_due} का भुगतान अभी बाकी है। कृपया रिसेप्शन पर या ऐप में भुगतान कर दें। धन्यवाद!',
    },
  },
  kn: {
    name: 'Kannada', native: 'ಕನ್ನಡ', locale: 'kn-IN',
    lines: {
      disclosure: 'ಇದು {gym} ಇಂದ ಬಂದಿರುವ ಸ್ವಯಂಚಾಲಿತ ಕರೆ.',
      press1: 'ನಮ್ಮೊಂದಿಗೆ ಮಾತನಾಡಲು 1 ಒತ್ತಿರಿ.',
      press2: {
        missed_visits: 'ನೀವು ಶೀಘ್ರದಲ್ಲೇ ಮತ್ತೆ ಬರುವುದಾದರೆ, 2 ಒತ್ತಿರಿ.',
        membership_ending: 'ನೀವು ಸದಸ್ಯತ್ವವನ್ನು ನವೀಕರಿಸುವುದಾದರೆ, 2 ಒತ್ತಿರಿ.',
        payment_due: 'ನೀವು ಶೀಘ್ರದಲ್ಲೇ ಪಾವತಿಸುವುದಾದರೆ, 2 ಒತ್ತಿರಿ.',
      },
      press9: 'ಈ ಕರೆಗಳನ್ನು ನಿಲ್ಲಿಸಲು 9 ಒತ್ತಿರಿ.',
      after1: 'ಧನ್ಯವಾದಗಳು. {gym} ಇಂದ ಯಾರಾದರೂ ಶೀಘ್ರದಲ್ಲೇ ನಿಮಗೆ ಕರೆ ಮಾಡುತ್ತಾರೆ.',
      after2: 'ಧನ್ಯವಾದಗಳು. ಶೀಘ್ರದಲ್ಲೇ ಭೇಟಿಯಾಗೋಣ!',
      after9: 'ಸರಿ. {gym} ನಿಮಗೆ ಮತ್ತೆ ಕರೆ ಮಾಡುವುದಿಲ್ಲ. ವಂದನೆಗಳು.',
      agentIntro: 'ನಮಸ್ಕಾರ {name}! ನಾನು {gym} ಇಂದ ಕರೆ ಮಾಡುತ್ತಿರುವ AI ಸಹಾಯಕ. ನಿಮಗೆ ಒಂದು ನಿಮಿಷ ಸಮಯವಿದೆಯೇ?',
    },
    quick: { callMe: 'ನನಗೆ ಕರೆ ಮಾಡಿ', onIt: { missed_visits: 'ಬೇಗ ಬರುತ್ತೇನೆ', membership_ending: 'ನವೀಕರಿಸುತ್ತೇನೆ', payment_due: 'ಪಾವತಿಸುತ್ತೇನೆ' }, stop: 'ಸಂದೇಶ ನಿಲ್ಲಿಸಿ' },
    starters: {
      missed_visits: 'ನಮಸ್ಕಾರ {name}! ನೀವು {days_absent} ದಿನಗಳಿಂದ ಜಿಮ್‌ಗೆ ಬಂದಿಲ್ಲ, ನಾವು ನಿಮ್ಮನ್ನು ಮಿಸ್ ಮಾಡುತ್ತಿದ್ದೇವೆ. ಈ ವಾರ ಒಂದು ಚಿಕ್ಕ ಸೆಷನ್ ಕೂಡ ನಿಮ್ಮ ಪ್ರಗತಿಯನ್ನು ಮುಂದುವರಿಸುತ್ತದೆ. ನಿಮ್ಮ ಟ್ರೈನರ್ ನಿಮಗಾಗಿ ಕಾಯುತ್ತಿದ್ದಾರೆ.',
      membership_ending: 'ನಮಸ್ಕಾರ {name}! ನಿಮ್ಮ ಸದಸ್ಯತ್ವ {end_date} ರಂದು ಮುಗಿಯುತ್ತದೆ. ತರಬೇತಿ ನಿಲ್ಲದಂತೆ ಸಮಯಕ್ಕೆ ಸರಿಯಾಗಿ ನವೀಕರಿಸಿ.',
      payment_due: 'ನಮಸ್ಕಾರ {name}! ನಿಮ್ಮ ಸದಸ್ಯತ್ವದ {amount_due} ಪಾವತಿ ಇನ್ನೂ ಬಾಕಿ ಇದೆ. ದಯವಿಟ್ಟು ರಿಸೆಪ್ಷನ್‌ನಲ್ಲಿ ಅಥವಾ ಆ್ಯಪ್‌ನಲ್ಲಿ ಪಾವತಿಸಿ. ಧನ್ಯವಾದಗಳು!',
    },
  },
  ta: {
    name: 'Tamil', native: 'தமிழ்', locale: 'ta-IN',
    lines: {
      disclosure: 'இது {gym} இலிருந்து வரும் தானியங்கி அழைப்பு.',
      press1: 'எங்களுடன் பேச 1 ஐ அழுத்தவும்.',
      press2: {
        missed_visits: 'நீங்கள் விரைவில் மீண்டும் வருவீர்கள் என்றால், 2 ஐ அழுத்தவும்.',
        membership_ending: 'உங்கள் உறுப்பினர் திட்டத்தைப் புதுப்பிப்பீர்கள் என்றால், 2 ஐ அழுத்தவும்.',
        payment_due: 'விரைவில் கட்டணம் செலுத்துவீர்கள் என்றால், 2 ஐ அழுத்தவும்.',
      },
      press9: 'இந்த அழைப்புகளை நிறுத்த 9 ஐ அழுத்தவும்.',
      after1: 'நன்றி. {gym} இலிருந்து ஒருவர் விரைவில் உங்களை அழைப்பார்.',
      after2: 'நன்றி. விரைவில் சந்திப்போம்!',
      after9: 'சரி. {gym} இனி உங்களை அழைக்காது. நன்றி.',
      agentIntro: 'வணக்கம் {name}! நான் {gym} இலிருந்து அழைக்கும் AI உதவியாளர். உங்களுக்கு ஒரு நிமிடம் நேரம் இருக்கிறதா?',
    },
    quick: { callMe: 'என்னை அழைக்கவும்', onIt: { missed_visits: 'விரைவில் வருகிறேன்', membership_ending: 'புதுப்பிக்கிறேன்', payment_due: 'செலுத்துகிறேன்' }, stop: 'செய்திகளை நிறுத்து' },
    starters: {
      missed_visits: 'வணக்கம் {name}! நீங்கள் {days_absent} நாட்களாக ஜிம்முக்கு வரவில்லை, உங்களை மிஸ் செய்கிறோம். இந்த வாரம் ஒரு சிறிய பயிற்சி கூட உங்கள் முன்னேற்றத்தைத் தொடரச் செய்யும். உங்கள் பயிற்சியாளர் உங்களுக்காகக் காத்திருக்கிறார்.',
      membership_ending: 'வணக்கம் {name}! உங்கள் உறுப்பினர் திட்டம் {end_date} அன்று முடிகிறது. இடைவெளி இல்லாமல் பயிற்சியைத் தொடர நேரத்தில் புதுப்பிக்கவும்.',
      payment_due: 'வணக்கம் {name}! உங்கள் உறுப்பினர் திட்டத்திற்கான {amount_due} கட்டணம் இன்னும் நிலுவையில் உள்ளது. தயவுசெய்து வரவேற்பறையில் அல்லது ஆப்பில் செலுத்துங்கள். நன்றி!',
    },
  },
  te: {
    name: 'Telugu', native: 'తెలుగు', locale: 'te-IN',
    lines: {
      disclosure: 'ఇది {gym} నుండి వచ్చిన ఆటోమేటెడ్ కాల్.',
      press1: 'మాతో మాట్లాడటానికి 1 నొక్కండి.',
      press2: {
        missed_visits: 'మీరు త్వరలో తిరిగి వస్తారంటే, 2 నొక్కండి.',
        membership_ending: 'మీరు మెంబర్‌షిప్ రెన్యూ చేస్తారంటే, 2 నొక్కండి.',
        payment_due: 'మీరు త్వరలో చెల్లిస్తారంటే, 2 నొక్కండి.',
      },
      press9: 'ఈ కాల్స్ ఆపడానికి 9 నొక్కండి.',
      after1: 'ధన్యవాదాలు. {gym} నుండి ఎవరైనా త్వరలో మీకు కాల్ చేస్తారు.',
      after2: 'ధన్యవాదాలు. త్వరలో కలుద్దాం!',
      after9: 'సరే. {gym} మీకు మళ్లీ కాల్ చేయదు. ధన్యవాదాలు.',
      agentIntro: 'నమస్తే {name}! నేను {gym} నుండి కాల్ చేస్తున్న AI అసిస్టెంట్‌ని. మీకు ఒక్క నిమిషం సమయం ఉందా?',
    },
    quick: { callMe: 'నాకు కాల్ చేయండి', onIt: { missed_visits: 'త్వరలో వస్తాను', membership_ending: 'రెన్యూ చేస్తాను', payment_due: 'చెల్లిస్తాను' }, stop: 'మెసేజ్‌లు ఆపండి' },
    starters: {
      missed_visits: 'నమస్తే {name}! మీరు {days_absent} రోజులుగా జిమ్‌కు రాలేదు, మిమ్మల్ని మిస్ అవుతున్నాం. ఈ వారం ఒక చిన్న సెషన్ అయినా మీ ప్రోగ్రెస్‌ను కొనసాగిస్తుంది. మీ ట్రైనర్ మీ కోసం ఎదురుచూస్తున్నారు.',
      membership_ending: 'నమస్తే {name}! మీ మెంబర్‌షిప్ {end_date} న ముగుస్తుంది. ట్రైనింగ్ ఆగకుండా సమయానికి రెన్యూ చేసుకోండి.',
      payment_due: 'నమస్తే {name}! మీ మెంబర్‌షిప్‌కు సంబంధించిన {amount_due} చెల్లింపు ఇంకా పెండింగ్‌లో ఉంది. దయచేసి రిసెప్షన్‌లో లేదా యాప్‌లో చెల్లించండి. ధన్యవాదాలు!',
    },
  },
  mr: {
    name: 'Marathi', native: 'मराठी', locale: 'mr-IN',
    lines: {
      disclosure: 'हा {gym} कडून आलेला ऑटोमेटेड कॉल आहे.',
      press1: 'आमच्याशी बोलण्यासाठी 1 दाबा.',
      press2: {
        missed_visits: 'तुम्ही लवकरच परत येणार असाल, तर 2 दाबा.',
        membership_ending: 'तुम्ही मेंबरशिप रिन्यू करणार असाल, तर 2 दाबा.',
        payment_due: 'तुम्ही लवकरच पेमेंट करणार असाल, तर 2 दाबा.',
      },
      press9: 'हे कॉल बंद करण्यासाठी 9 दाबा.',
      after1: 'धन्यवाद. {gym} मधून कोणीतरी लवकरच तुम्हाला कॉल करेल.',
      after2: 'धन्यवाद. लवकरच भेटू!',
      after9: 'ठीक आहे. {gym} तुम्हाला पुन्हा कॉल करणार नाही. धन्यवाद.',
      agentIntro: 'नमस्कार {name}! हा {gym} चा AI असिस्टंट आहे. तुमच्याकडे एक मिनिट आहे का?',
    },
    quick: { callMe: 'मला कॉल करा', onIt: { missed_visits: 'लवकरच येईन', membership_ending: 'रिन्यू करेन', payment_due: 'पेमेंट करेन' }, stop: 'मेसेज बंद करा' },
    starters: {
      missed_visits: 'नमस्कार {name}! तुम्ही {days_absent} दिवसांपासून जिममध्ये आला नाहीत, आम्हाला तुमची आठवण येते आहे. या आठवड्यात एक छोटं सेशनसुद्धा तुमची प्रगती चालू ठेवेल. तुमचे ट्रेनर तुमची वाट पाहत आहेत.',
      membership_ending: 'नमस्कार {name}! तुमची मेंबरशिप {end_date} रोजी संपत आहे. ट्रेनिंगमध्ये खंड पडू नये म्हणून वेळेवर रिन्यू करा.',
      payment_due: 'नमस्कार {name}! तुमच्या मेंबरशिपचे {amount_due} चे पेमेंट अजून बाकी आहे. कृपया रिसेप्शनवर किंवा ॲपमध्ये पेमेंट करा. धन्यवाद!',
    },
  },
  bn: {
    name: 'Bengali', native: 'বাংলা', locale: 'bn-IN',
    lines: {
      disclosure: 'এটি {gym} থেকে একটি স্বয়ংক্রিয় কল।',
      press1: 'আমাদের সঙ্গে কথা বলতে 1 টিপুন।',
      press2: {
        missed_visits: 'আপনি যদি শিগগিরই আবার আসেন, 2 টিপুন।',
        membership_ending: 'আপনি যদি মেম্বারশিপ রিনিউ করেন, 2 টিপুন।',
        payment_due: 'আপনি যদি শিগগিরই পেমেন্ট করেন, 2 টিপুন।',
      },
      press9: 'এই কলগুলো বন্ধ করতে 9 টিপুন।',
      after1: 'ধন্যবাদ। {gym} থেকে কেউ শিগগিরই আপনাকে কল করবেন।',
      after2: 'ধন্যবাদ। শিগগিরই দেখা হবে!',
      after9: 'ঠিক আছে। {gym} আর আপনাকে কল করবে না। ধন্যবাদ।',
      agentIntro: 'নমস্কার {name}! আমি {gym} থেকে কল করা একটি AI সহকারী। আপনার কি এক মিনিট সময় হবে?',
    },
    quick: { callMe: 'আমাকে কল করুন', onIt: { missed_visits: 'শিগগিরই আসছি', membership_ending: 'রিনিউ করব', payment_due: 'পেমেন্ট করব' }, stop: 'মেসেজ বন্ধ করুন' },
    starters: {
      missed_visits: 'নমস্কার {name}! আপনি {days_absent} দিন ধরে জিমে আসেননি, আমরা আপনাকে মিস করছি। এই সপ্তাহে একটা ছোট সেশনও আপনার অগ্রগতি ধরে রাখবে। আপনার ট্রেনার আপনার জন্য অপেক্ষা করছেন।',
      membership_ending: 'নমস্কার {name}! আপনার মেম্বারশিপ {end_date} তারিখে শেষ হচ্ছে। ট্রেনিং না থামিয়ে চালিয়ে যেতে সময়মতো রিনিউ করুন।',
      payment_due: 'নমস্কার {name}! আপনার মেম্বারশিপের {amount_due} পেমেন্ট এখনও বাকি আছে। অনুগ্রহ করে রিসেপশনে বা অ্যাপে পেমেন্ট করুন। ধন্যবাদ!',
    },
  },
  gu: {
    name: 'Gujarati', native: 'ગુજરાતી', locale: 'gu-IN',
    lines: {
      disclosure: 'આ {gym} તરફથી આવેલો ઓટોમેટેડ કૉલ છે.',
      press1: 'અમારી સાથે વાત કરવા માટે 1 દબાવો.',
      press2: {
        missed_visits: 'જો તમે જલ્દી પાછા આવવાના હો, તો 2 દબાવો.',
        membership_ending: 'જો તમે મેમ્બરશિપ રિન્યૂ કરવાના હો, તો 2 દબાવો.',
        payment_due: 'જો તમે જલ્દી પેમેન્ટ કરવાના હો, તો 2 દબાવો.',
      },
      press9: 'આ કૉલ બંધ કરવા માટે 9 દબાવો.',
      after1: 'આભાર. {gym} માંથી કોઈ જલ્દી તમને કૉલ કરશે.',
      after2: 'આભાર. જલ્દી મળીએ!',
      after9: 'બરાબર. {gym} તમને ફરી કૉલ નહીં કરે. આભાર.',
      agentIntro: 'નમસ્તે {name}! આ {gym} નો AI આસિસ્ટન્ટ છે. શું તમારી પાસે એક મિનિટ છે?',
    },
    quick: { callMe: 'મને કૉલ કરો', onIt: { missed_visits: 'જલ્દી આવીશ', membership_ending: 'રિન્યૂ કરીશ', payment_due: 'પેમેન્ટ કરીશ' }, stop: 'મેસેજ બંધ કરો' },
    starters: {
      missed_visits: 'નમસ્તે {name}! તમે {days_absent} દિવસથી જીમમાં આવ્યા નથી, અમે તમને યાદ કરીએ છીએ. આ અઠવાડિયે એક નાનું સેશન પણ તમારી પ્રગતિ જાળવી રાખશે. તમારા ટ્રેનર તમારી રાહ જોઈ રહ્યા છે.',
      membership_ending: 'નમસ્તે {name}! તમારી મેમ્બરશિપ {end_date} ના રોજ પૂરી થાય છે. ટ્રેનિંગમાં વિરામ ન આવે તે માટે સમયસર રિન્યૂ કરો.',
      payment_due: 'નમસ્તે {name}! તમારી મેમ્બરશિપનું {amount_due} નું પેમેન્ટ હજુ બાકી છે. કૃપા કરીને રિસેપ્શન પર અથવા એપમાં પેમેન્ટ કરો. આભાર!',
    },
  },
  ml: {
    name: 'Malayalam', native: 'മലയാളം', locale: 'ml-IN',
    lines: {
      disclosure: 'ഇത് {gym} ൽ നിന്നുള്ള ഒരു ഓട്ടോമേറ്റഡ് കോൾ ആണ്.',
      press1: 'ഞങ്ങളോട് സംസാരിക്കാൻ 1 അമർത്തുക.',
      press2: {
        missed_visits: 'നിങ്ങൾ ഉടൻ തിരികെ വരുമെങ്കിൽ, 2 അമർത്തുക.',
        membership_ending: 'നിങ്ങൾ മെമ്പർഷിപ്പ് പുതുക്കുമെങ്കിൽ, 2 അമർത്തുക.',
        payment_due: 'നിങ്ങൾ ഉടൻ പണം അടയ്ക്കുമെങ്കിൽ, 2 അമർത്തുക.',
      },
      press9: 'ഈ കോളുകൾ നിർത്താൻ 9 അമർത്തുക.',
      after1: 'നന്ദി. {gym} ൽ നിന്ന് ആരെങ്കിലും ഉടൻ നിങ്ങളെ വിളിക്കും.',
      after2: 'നന്ദി. ഉടൻ കാണാം!',
      after9: 'ശരി. {gym} ഇനി നിങ്ങളെ വിളിക്കില്ല. നന്ദി.',
      agentIntro: 'നമസ്കാരം {name}! ഞാൻ {gym} ൽ നിന്ന് വിളിക്കുന്ന ഒരു AI അസിസ്റ്റന്റ് ആണ്. നിങ്ങൾക്ക് ഒരു മിനിറ്റ് സമയമുണ്ടോ?',
    },
    quick: { callMe: 'എന്നെ വിളിക്കൂ', onIt: { missed_visits: 'ഉടൻ വരാം', membership_ending: 'പുതുക്കാം', payment_due: 'പണം അടയ്ക്കാം' }, stop: 'സന്ദേശങ്ങൾ നിർത്തൂ' },
    starters: {
      missed_visits: 'നമസ്കാരം {name}! നിങ്ങൾ {days_absent} ദിവസമായി ജിമ്മിൽ വന്നിട്ടില്ല, ഞങ്ങൾ നിങ്ങളെ മിസ് ചെയ്യുന്നു. ഈ ആഴ്ച ഒരു ചെറിയ സെഷൻ പോലും നിങ്ങളുടെ പുരോഗതി നിലനിർത്തും. നിങ്ങളുടെ ട്രെയിനർ നിങ്ങൾക്കായി കാത്തിരിക്കുന്നു.',
      membership_ending: 'നമസ്കാരം {name}! നിങ്ങളുടെ മെമ്പർഷിപ്പ് {end_date} ന് അവസാനിക്കുന്നു. പരിശീലനം മുടങ്ങാതിരിക്കാൻ സമയത്ത് പുതുക്കുക.',
      payment_due: 'നമസ്കാരം {name}! നിങ്ങളുടെ മെമ്പർഷിപ്പിന്റെ {amount_due} പേയ്മെന്റ് ഇനിയും ബാക്കിയുണ്ട്. ദയവായി റിസപ്ഷനിലോ ആപ്പിലോ പണമടയ്ക്കുക. നന്ദി!',
    },
  },
  pa: {
    name: 'Punjabi', native: 'ਪੰਜਾਬੀ', locale: 'pa-IN',
    lines: {
      disclosure: 'ਇਹ {gym} ਵੱਲੋਂ ਇੱਕ ਆਟੋਮੇਟਿਡ ਕਾਲ ਹੈ।',
      press1: 'ਸਾਡੇ ਨਾਲ ਗੱਲ ਕਰਨ ਲਈ 1 ਦਬਾਓ।',
      press2: {
        missed_visits: 'ਜੇ ਤੁਸੀਂ ਜਲਦੀ ਵਾਪਸ ਆ ਰਹੇ ਹੋ, ਤਾਂ 2 ਦਬਾਓ।',
        membership_ending: 'ਜੇ ਤੁਸੀਂ ਮੈਂਬਰਸ਼ਿਪ ਰੀਨਿਊ ਕਰੋਗੇ, ਤਾਂ 2 ਦਬਾਓ।',
        payment_due: 'ਜੇ ਤੁਸੀਂ ਜਲਦੀ ਭੁਗਤਾਨ ਕਰੋਗੇ, ਤਾਂ 2 ਦਬਾਓ।',
      },
      press9: 'ਇਹ ਕਾਲਾਂ ਬੰਦ ਕਰਨ ਲਈ 9 ਦਬਾਓ।',
      after1: 'ਧੰਨਵਾਦ। {gym} ਤੋਂ ਕੋਈ ਜਲਦੀ ਤੁਹਾਨੂੰ ਕਾਲ ਕਰੇਗਾ।',
      after2: 'ਧੰਨਵਾਦ। ਜਲਦੀ ਮਿਲਦੇ ਹਾਂ!',
      after9: 'ਠੀਕ ਹੈ। {gym} ਤੁਹਾਨੂੰ ਦੁਬਾਰਾ ਕਾਲ ਨਹੀਂ ਕਰੇਗਾ। ਧੰਨਵਾਦ।',
      agentIntro: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}! ਇਹ {gym} ਦਾ AI ਅਸਿਸਟੈਂਟ ਹੈ। ਕੀ ਤੁਹਾਡੇ ਕੋਲ ਇੱਕ ਮਿੰਟ ਹੈ?',
    },
    quick: { callMe: 'ਮੈਨੂੰ ਕਾਲ ਕਰੋ', onIt: { missed_visits: 'ਜਲਦੀ ਆ ਰਹੇ ਹਾਂ', membership_ending: 'ਰੀਨਿਊ ਕਰਾਂਗੇ', payment_due: 'ਭੁਗਤਾਨ ਕਰਾਂਗੇ' }, stop: 'ਮੈਸੇਜ ਬੰਦ ਕਰੋ' },
    starters: {
      missed_visits: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}! ਤੁਸੀਂ {days_absent} ਦਿਨਾਂ ਤੋਂ ਜਿਮ ਨਹੀਂ ਆਏ, ਸਾਨੂੰ ਤੁਹਾਡੀ ਯਾਦ ਆ ਰਹੀ ਹੈ। ਇਸ ਹਫ਼ਤੇ ਇੱਕ ਛੋਟਾ ਜਿਹਾ ਸੈਸ਼ਨ ਵੀ ਤੁਹਾਡੀ ਤਰੱਕੀ ਜਾਰੀ ਰੱਖੇਗਾ। ਤੁਹਾਡਾ ਟ੍ਰੇਨਰ ਤੁਹਾਡੀ ਉਡੀਕ ਕਰ ਰਿਹਾ ਹੈ।',
      membership_ending: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}! ਤੁਹਾਡੀ ਮੈਂਬਰਸ਼ਿਪ {end_date} ਨੂੰ ਖ਼ਤਮ ਹੋ ਰਹੀ ਹੈ। ਟ੍ਰੇਨਿੰਗ ਬਿਨਾਂ ਰੁਕੇ ਜਾਰੀ ਰੱਖਣ ਲਈ ਸਮੇਂ ਸਿਰ ਰੀਨਿਊ ਕਰੋ।',
      payment_due: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}! ਤੁਹਾਡੀ ਮੈਂਬਰਸ਼ਿਪ ਦਾ {amount_due} ਦਾ ਭੁਗਤਾਨ ਅਜੇ ਬਾਕੀ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਰਿਸੈਪਸ਼ਨ 'ਤੇ ਜਾਂ ਐਪ ਵਿੱਚ ਭੁਗਤਾਨ ਕਰੋ। ਧੰਨਵਾਦ!",
    },
  },
};

/* New members who have not come in yet ("onboarding"): their own "press 2"
   and starter message; the quick reply reuses the "back soon" wording. */
const ONBOARDING = {
  en: ["If you'll come in soon, press 2.", "Hi {name}, welcome to {gym}! We'd love to see you for your first session. Drop in any time this week and our trainers will get you started."],
  hi: ['अगर आप जल्द आ रहे हैं, तो 2 दबाएँ।', 'नमस्ते {name}, {gym} में आपका स्वागत है! हम आपके पहले सेशन का इंतज़ार कर रहे हैं। इस हफ़्ते कभी भी आइए, हमारे ट्रेनर आपकी शुरुआत करवाएँगे।'],
  kn: ['ನೀವು ಶೀಘ್ರದಲ್ಲೇ ಬರುವುದಾದರೆ, 2 ಒತ್ತಿರಿ.', 'ನಮಸ್ಕಾರ {name}, {gym} ಗೆ ಸ್ವಾಗತ! ನಿಮ್ಮ ಮೊದಲ ಸೆಷನ್‌ಗಾಗಿ ನಾವು ಕಾಯುತ್ತಿದ್ದೇವೆ. ಈ ವಾರ ಯಾವಾಗ ಬೇಕಾದರೂ ಬನ್ನಿ, ನಮ್ಮ ಟ್ರೈನರ್‌ಗಳು ನಿಮಗೆ ಆರಂಭಿಸಲು ಸಹಾಯ ಮಾಡುತ್ತಾರೆ.'],
  ta: ['நீங்கள் விரைவில் வருவீர்கள் என்றால், 2 ஐ அழுத்தவும்.', 'வணக்கம் {name}, {gym} க்கு வரவேற்கிறோம்! உங்கள் முதல் பயிற்சிக்காகக் காத்திருக்கிறோம். இந்த வாரம் எப்போது வேண்டுமானாலும் வாருங்கள், எங்கள் பயிற்சியாளர்கள் உங்களைத் தொடங்க வைப்பார்கள்.'],
  te: ['మీరు త్వరలో వస్తారంటే, 2 నొక్కండి.', 'నమస్తే {name}, {gym} కి స్వాగతం! మీ మొదటి సెషన్ కోసం ఎదురుచూస్తున్నాం. ఈ వారం ఎప్పుడైనా రండి, మా ట్రైనర్లు మీకు మొదలుపెట్టడంలో సహాయం చేస్తారు.'],
  mr: ['तुम्ही लवकरच येणार असाल, तर 2 दाबा.', 'नमस्कार {name}, {gym} मध्ये तुमचे स्वागत आहे! तुमच्या पहिल्या सेशनची आम्ही वाट पाहत आहोत. या आठवड्यात कधीही या, आमचे ट्रेनर तुमची सुरुवात करून देतील.'],
  bn: ['আপনি যদি শিগগিরই আসেন, 2 টিপুন।', 'নমস্কার {name}, {gym}-এ আপনাকে স্বাগত! আপনার প্রথম সেশনের জন্য আমরা অপেক্ষা করছি। এই সপ্তাহে যেকোনো সময় চলে আসুন, আমাদের ট্রেনাররা আপনাকে শুরু করিয়ে দেবেন।'],
  gu: ['જો તમે જલ્દી આવવાના હો, તો 2 દબાવો.', 'નમસ્તે {name}, {gym} માં તમારું સ્વાગત છે! તમારા પહેલા સેશનની અમે રાહ જોઈએ છીએ. આ અઠવાડિયે ગમે ત્યારે આવો, અમારા ટ્રેનર્સ તમને શરૂઆત કરાવશે.'],
  ml: ['നിങ്ങൾ ഉടൻ വരുമെങ്കിൽ, 2 അമർത്തുക.', 'നമസ്കാരം {name}, {gym} ലേക്ക് സ്വാഗതം! നിങ്ങളുടെ ആദ്യ സെഷനായി ഞങ്ങൾ കാത്തിരിക്കുന്നു. ഈ ആഴ്ച എപ്പോൾ വേണമെങ്കിലും വരൂ, ഞങ്ങളുടെ ട്രെയിനർമാർ നിങ്ങളെ തുടങ്ങാൻ സഹായിക്കും.'],
  pa: ['ਜੇ ਤੁਸੀਂ ਜਲਦੀ ਆ ਰਹੇ ਹੋ, ਤਾਂ 2 ਦਬਾਓ।', 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}, {gym} ਵਿੱਚ ਤੁਹਾਡਾ ਸਵਾਗਤ ਹੈ! ਅਸੀਂ ਤੁਹਾਡੇ ਪਹਿਲੇ ਸੈਸ਼ਨ ਦੀ ਉਡੀਕ ਕਰ ਰਹੇ ਹਾਂ। ਇਸ ਹਫ਼ਤੇ ਕਦੇ ਵੀ ਆਓ, ਸਾਡੇ ਟ੍ਰੇਨਰ ਤੁਹਾਡੀ ਸ਼ੁਰੂਆਤ ਕਰਵਾਉਣਗੇ।'],
};
for (const [code, [press2, starter]] of Object.entries(ONBOARDING)) {
  L[code].lines.press2.onboarding = press2;
  L[code].starters.onboarding = starter;
  L[code].quick.onIt.onboarding = L[code].quick.onIt.missed_visits;
}
KINDS.push('onboarding');

export const LANGUAGE_CODES = Object.keys(L);
export const DEFAULT_LANGUAGE = 'en';
export const RULE_KINDS = KINDS;

export const isLanguage = (code) => Object.prototype.hasOwnProperty.call(L, code);
const lang = (code) => L[isLanguage(code) ? code : DEFAULT_LANGUAGE];

/** For pickers: [{ code, name, native }]. */
export function languageList() {
  return LANGUAGE_CODES.map((code) => ({ code, name: L[code].name, native: L[code].native }));
}

export const localeFor = (code) => lang(code).locale;
export const starterFor = (code, kind) => lang(code).starters[kind] || L.en.starters[kind] || '';
export const quickRepliesFor = (code, kind) => {
  const q = lang(code).quick;
  return { callMe: q.callMe, onIt: q.onIt[kind] || q.onIt.missed_visits, stop: q.stop };
};

/**
 * The spoken lines for one call, in `code`, with a gym's own rewording
 * (followup_settings.lines_json: { [code]: { disclosure, press1, ... } })
 * laid over the defaults. press2 is resolved for `kind`. Only string
 * values from the override are taken, so a malformed row can't break a call.
 */
export function spokenLines(code, kind, overrides) {
  const base = lang(code).lines;
  const out = {
    disclosure: base.disclosure, press1: base.press1, press2: base.press2[kind] || base.press2.missed_visits,
    press9: base.press9, after1: base.after1, after2: base.after2, after9: base.after9, agentIntro: base.agentIntro,
  };
  const o = overrides && typeof overrides === 'object' ? overrides[isLanguage(code) ? code : DEFAULT_LANGUAGE] : null;
  if (o && typeof o === 'object') {
    for (const k of Object.keys(out)) {
      const v = k === 'press2' && o.press2 && typeof o.press2 === 'object' ? o.press2[kind] : o[k];
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 300);
    }
  }
  return out;
}

/** Every default line for `code`, for the settings editor. */
export function defaultLines(code) {
  return JSON.parse(JSON.stringify(lang(code).lines));
}
