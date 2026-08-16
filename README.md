# Clock & Events Display

A fully responsive, lightweight 12-hour digital clock with smart event countdown system, optimized for low-end hardware and fullscreen displays.

## Features

### Clock Display
- **12-hour digital format** with hours, minutes, and seconds (no AM/PM indicator)
- **Minimal, modern design** with extra-bold typography
- **Dynamic font sizing** that scales to fill the entire screen
- **Current date display** beneath the clock
- **Fully responsive** - works seamlessly on landscape and portrait orientations
- **Zero scrolling** - all content always fits within the viewport

### Event System
- **CSV-based event management** - manually curate events to avoid unwanted calendar entries
- **Real-time data fetching** - no caching, always loads fresh event data
- **Multiple events per day** support - display all events happening on the same day
- **Smart layout adjustment** - clock automatically centers with dynamic spacing when events are present

### ProgressBar Events (Countdown System)
- **8-day countdown** - automatic countdown begins exactly 8 days before ProgressBar events
- **Hour-accurate progress** - progress bar updates every hour (not just daily)
- **Multiple countdowns** - display multiple ProgressBar events simultaneously
- **Visual feedback** with dynamic background colors:
  - **Default**: Black background
  - **4+ days before**: Subtle dark purple gradient
  - **1 day before**: Maroon (#830300)
  - **Event day**: Orange (#ed6d19)
- **Progress bar display** - only shows for ProgressBar-type events; regular events display without countdown

### Fullscreen Support
- **Single-tap toggle** - click or tap anywhere on the screen to enter/exit fullscreen
- **Seamless transitions** - maintains layout and functionality in both modes

### Low-CPU Optimization
- **1-second update interval** instead of 60fps - minimal CPU and battery usage
- **Lightweight codebase** - pure HTML/CSS/JavaScript with no frameworks
- **Efficient rendering** - optimized for low-end hardware and embedded displays

### Accessibility
- **No-JavaScript fallback** - displays "Javascript is not supported on this browser" message if JS fails
- **Responsive text scaling** - font sizes adapt using CSS clamp() for all screen sizes

## File Structure

```
clockadashi/
├── index.html          # Main HTML document
├── styles.css          # Responsive styling and layout
├── script.js           # Clock logic and event system
├── events.csv          # Event data (manually maintained)
└── README.md           # This file
```

## Getting Started

### 1. Setup
- Open `index.html` in a modern web browser
- Ensure `styles.css` and `script.js` are in the same directory
- Place `events.csv` in the same directory (critical for event loading)

### 2. Add Events

Edit `events.csv` with your events. CSV format:

```
Date,Event,Type
2026-03-08,Event Name,ProgressBar
2026-03-15,Another Event,
2026-03-20,Third Event,ProgressBar
```

**Columns:**
- **Date**: Event date in `YYYY-MM-DD` format
- **Event**: Event name/description (displayed on screen)
- **Type**: Event type classification
  - `ProgressBar` - Enables 8-day countdown with progress bar
  - Leave empty for regular events (displays on event day only)

**Example:**
```csv
Date,Event,Type
2026-03-03,Test Nirjala Ekadashi,ProgressBar
2026-03-05,Solar Eclipse,
2026-03-08,Nar Narayan Dev Jayanti,ProgressBar
2026-04-10,Mandir Event,
2026-04-05,Ekadashi,ProgressBar
```

### 3. Host the Files
- Deploy to any web server (Apache, Nginx, etc.)
- No backend required - works as static files
- Works offline after initial load (except event CSV fetching)

## Usage

### Viewing the Clock
- The clock auto-updates every second
- Date appears below the clock
- Font sizes scale automatically to fit your screen

### Interacting with Events
- **Today's events** appear in the center above the clock
- **ProgressBar countdowns** display below the clock with:
  - Countdown text: "X days until [Event Name] on [Weekday]"
  - Hour-accurate progress bar beneath the text
- Multiple events display as separate lines without overlap

### Switching Fullscreen
- **Tap/click anywhere** on the screen to toggle fullscreen mode
- Works on both desktop and mobile devices
- Layout adjusts seamlessly

### Managing Events (CSV)
- Edit `events.csv` in any text editor
- Changes are instantly reflected on reload (no server restart needed)
- CSV is fetched fresh every page load - no browser caching
- Add/remove/modify dates and event names as needed

## Technical Details

### Browser Compatibility
- Modern browsers supporting ES6 JavaScript
- Chrome/Edge 60+
- Firefox 55+
- Safari 12+
- Mobile browsers (iOS Safari, Chrome Mobile, etc.)

### Performance
- **CPU usage**: Minimal (1-second update cycle)
- **Memory usage**: <5MB
- **Network**: Single CSV fetch per page load
- **Battery**: Optimized for mobile devices with low polling rate

### Responsive Design
- CSS `clamp()` function for fluid font scaling
- Flexbox layout for automatic centering
- Viewport-relative units (vw, vh) for screen-aware sizing
- Zero horizontal scrolling guaranteed

### Event Processing
- Events within 8 days set to "ProgressBar" type trigger countdown mode
- Events on the current day display in the event section
- Events are sorted by proximity (closest first)
- Background colors update based on the nearest upcoming event

## Customization

### Font Styles
Edit `styles.css` to change fonts:
```css
font-family: 'Roboto', 'Google Sans', 'Inter', sans-serif;
```

### Colors
Modify background colors in `styles.css`:
```css
body.progressbar-day { background-color: #ed6d19; }
body.progressbar-1day { background-color: #830300; }
body.progressbar-4days { background: linear-gradient(135deg, #000 0%, #2d0033 100%); }
```

### Font Sizing
Adjust responsive font scales in `styles.css` using `clamp()`:
```css
font-size: clamp(min, preferred, max);
```

### Event Types
Add new event type handling in `script.js` by extending the CSV parsing logic.

## Troubleshooting

### Events Not Loading
- Verify `events.csv` is in the same directory as `index.html`
- Check CSV format is correct (three columns: Date, Event, Type)
- Ensure dates are in `YYYY-MM-DD` format
- Open browser developer console (F12) to check for fetch errors

### Clock Not Displaying
- Verify JavaScript is enabled in browser settings
- Check console for errors
- Ensure all three files (HTML, CSS, JS) are present and accessible

### Progress Bar Not Showing
- Verify event `Type` column contains exactly `ProgressBar` (case-insensitive)
- Confirm event date is within the next 8 days

### Font Size Too Small/Large
- Adjust viewport zoom in browser
- Modify `clamp()` values in `styles.css`
- Check for CSS file loading errors in browser console

## License

Free to use and modify for personal or commercial projects.

## Support

For issues or feature requests, review the code comments in `script.js` and `styles.css` for implementation details.
