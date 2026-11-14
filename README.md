# हडलाय कलां - गाँव की वेबसाइट | Hadlay Kalan - Village Website

A modern, bilingual (Hindi/English) village website with iOS-style navigation, built with Node.js, Express, MongoDB, and vanilla JavaScript.

## ✨ Features

### 🌐 Bilingual Support
- **Default Language**: Hindi (हिंदी)
- **Toggle**: Click the language button to switch between Hindi and English
- **Persistent**: Language preference saved in browser

### 📱 Core Features
- **Home Page**: Hero slider, weather widget, latest notices, mandi rates, village info
- **Notices**: Village announcements with WhatsApp sharing
- **Contacts**: Important village persons with approval system
- **Farmer Section**: Daily mandi rates, weather for farming, farming tips
- **Admin Panel**: Full CRUD operations for all content
- **Responsive Design**: Mobile-first with iOS-style bottom navigation

### 🎨 Design
- iOS-inspired bottom navigation
- Smooth animations and transitions
- Dark/Light mode ready
- Mobile-first responsive design
- Beautiful glassmorphism effects

## 🚀 Quick Start

### Local Development

```bash
# 1. Clone repository
cd "Hadlay Kalan"

# 2. Install dependencies
npm install

# 3. Create .env file (copy from .env.example)
cp .env.example .env

# 4. Edit .env with your credentials
# - MongoDB connection string
# - Cloudinary credentials
# - JWT secret

# 5. Start server
npm start
# or for development with auto-reload:
npm run dev

# 6. Open browser
# Frontend: http://localhost:5001
# Admin: http://localhost:5001/admin
```

### Default Admin Credentials
- **Email**: admin@hadlaykalan.com
- **Password**: admin123
- ⚠️ **Change immediately after first login!**


## 🌍 Deployment

**Frontend and Backend are deployed separately for optimal performance.**

### Quick Deploy Guide
See [DEPLOY-QUICK-START.md](./DEPLOY-QUICK-START.md) for complete 15-minute deployment guide.

### Deployment Architecture
```
Frontend (Static)  →  Backend (API)  →  MongoDB Atlas
   Vercel/Netlify      Render/Railway      (Database)
        ↓                    ↓                  ↓
   public/ folder      server.js + routes   Cloudinary (Images)
```

### Quick Links
- **[Frontend Deployment](./FRONTEND-DEPLOYMENT.md)** - Deploy static site to Vercel/Netlify
- **[Backend Deployment](./BACKEND-DEPLOYMENT.md)** - Deploy API to Render/Railway
- **[Complete Guide](./DEPLOY-QUICK-START.md)** - Step-by-step full deployment

### Update API URL for Production
After deploying backend, edit `/public/js/config.js`:
```javascript
const PRODUCTION_API = 'https://your-backend-url.onrender.com';
```

## 🗂️ Project Structure

```
Hadlay Kalan/
├── public/              # Frontend files
│   ├── index.html       # Main user-facing page
│   ├── admin.html       # Admin panel
│   ├── css/
│   │   ├── style.css    # Main styles
│   │   └── admin.css    # Admin styles
│   └── js/
│       ├── config.js    # API configuration
│       ├── translations.js  # Bilingual translations
│       ├── app.js       # Main frontend logic
│       └── admin.js     # Admin panel logic
├── models/              # MongoDB schemas
│   ├── Admin.js
│   ├── Slider.js
│   ├── Notice.js
│   ├── Contact.js
│   ├── Farmer.js
│   └── VillageInfo.js
├── routes/              # API endpoints
│   ├── auth.js
│   ├── sliders.js
│   ├── notices.js
│   ├── contacts.js
│   ├── farmer.js
│   ├── weather.js
│   └── villageInfo.js
├── middleware/          # Custom middleware
│   ├── auth.js          # JWT authentication
│   └── upload.js        # Cloudinary image upload
├── server.js            # Express server
├── .env.example         # Environment variables template
├── DEPLOYMENT.md        # Deployment guide
└── package.json         # Dependencies

```

## 🔧 Technology Stack

### Backend
- **Node.js** - Runtime
- **Express.js** - Web framework
- **MongoDB** - Database
- **Mongoose** - ODM
- **JWT** - Authentication
- **Cloudinary** - Image storage
- **Multer** - File uploads
- **BCrypt** - Password hashing

### Frontend
- **Vanilla JavaScript** - No frameworks!
- **HTML5** & **CSS3**
- **Font Awesome** - Icons
- **Google Fonts** - Poppins

### External APIs
- **OpenMeteo API** - Weather data (free, no API key needed)

## 🌐 Language Toggle

The website supports bilingual content:

### How It Works
1. **Default**: Website loads in Hindi (हिंदी)
2. **Toggle**: Click language button (🌐) in header
3. **Switch**: Content switches between Hindi ↔ English
4. **Persist**: Browser remembers your preference

### For Developers
Translation system uses:
- `/public/js/translations.js` - All translations
- `data-i18n` attributes in HTML
- `langManager.t('key')` in JavaScript

Add new translations:
```javascript
// In translations.js
hi: {
  myNewKey: 'हिंदी में टेक्स्ट'
},
en: {
  myNewKey: 'Text in English'
}

// In HTML
<span data-i18n="myNewKey">हिंदी में टेक्स्ट</span>

// In JavaScript
const text = langManager.t('myNewKey');
```

## 📱 Features Breakdown

### Home Page
- **Hero Slider**: Dynamic news/events with auto-play
- **Weather Widget**: Real-time weather with 5-day forecast
- **Notice Preview**: Latest 3 notices
- **Mandi Rates Preview**: Top 4 crop prices
- **Village Statistics**: Population, area, schools, hospitals

### Notices
- **Categories**: Events, Meetings, Announcements, Emergency, General
- **Filter**: By category
- **Share**: WhatsApp sharing with full content
- **Pin**: Important notices stay on top
- **Images**: Support for notice images

### Contacts
- **Important Persons**: Sarpanch, Doctor, Police, etc.
- **User Submission**: Anyone can add contact (needs approval)
- **Filter**: By role/profession
- **Call**: Direct call functionality

### Farmer Section
- **Mandi Rates**: Daily crop prices with trend indicators
- **Weather**: Farming-specific weather advice
- **Tips**: Categorized farming tips (Crop, Weather, Scheme, Market)

### Admin Panel
- **Dashboard**: Stats and pending approvals
- **Sliders**: Add/edit hero slider images
- **Notices**: CRUD operations with image upload
- **Contacts**: Approve/manage contacts
- **Mandi Rates**: Update crop prices
- **Farmer Tips**: Add farming advice
- **Village Info**: Update statistics

## 🔐 Security Features

- JWT authentication
- Password hashing (BCrypt)
- Protected admin routes
- Input validation
- CORS configured
- File size limits
- Secure defaults

## 📊 API Endpoints

### Public Endpoints
- `GET /api/sliders` - Get all sliders
- `GET /api/notices` - Get all notices
- `GET /api/contacts` - Get approved contacts
- `GET /api/farmer/mandi-rates` - Get mandi rates
- `GET /api/farmer/tips` - Get farming tips
- `GET /api/weather/:lat/:lon` - Get weather
- `GET /api/village-info` - Get village stats
- `POST /api/contacts/submit` - Submit contact request

### Admin Endpoints (Protected)
- `POST /api/auth/login` - Admin login
- All CRUD operations for: sliders, notices, contacts, mandi, tips
- `POST /api/contacts/approve/:id` - Approve contact

## 🐛 Troubleshooting

### Common Issues

**1. Server won't start**
- Check if port 5001 is free
- Verify MongoDB connection string
- Check all environment variables

**2. Images not uploading**
- Verify Cloudinary credentials
- Check file size (max 5MB)

**3. Admin login fails**
- Check JWT_SECRET is set

**4. Language not switching**
- Clear browser cache
- Check browser console for errors

**5. API not connecting**
- Verify backend is running
- Check API URL in config.js
- Check CORS settings

## 📝 Environment Variables

Required in `.env` file:

```env
PORT=5001
NODE_ENV=development
MONGODB_URI=your_mongodb_connection_string
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
JWT_SECRET=your_jwt_secret
ADMIN_EMAIL=admin@hadlaykalan.com
ADMIN_PASSWORD=admin123
FRONTEND_URL=*
```

## 🎯 Future Enhancements

- [ ] SMS notifications
- [ ] Push notifications
- [ ] User authentication
- [ ] Comments on notices
- [ ] Events calendar
- [ ] Photo gallery
- [ ] Village map integration
- [ ] Mobile app (React Native)
- [ ] Offline support (PWA)
- [ ] Multi-village support

## 📄 License

This project is open source and available for use by any village or community.

## 🙏 Acknowledgments

Built with ❤️ for rural communities.

Special thanks to:
- OpenMeteo for free weather API
- Cloudinary for image hosting
- MongoDB Atlas for free database
- All open-source contributors

## 📞 Support

For issues or questions:
1. Check [DEPLOYMENT.md](./DEPLOYMENT.md)
2. Review this README
3. Check browser console (F12)
4. Check server logs

---

**⭐ Star this project if it helps your village!**

---

## Quick Commands Reference

```bash
# Development
npm install          # Install dependencies
npm start            # Start server
npm run dev          # Start with auto-reload

# Testing
curl http://localhost:5001/api/health  # Check if API is running
curl http://localhost:5001/api/notices # Test API endpoint

# Deployment
npm start            # Production start command
```

---

Made with 🌾 for villages
