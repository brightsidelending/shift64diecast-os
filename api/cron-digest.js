import nodemailer from 'nodemailer';
export default async function handler(req, res) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'Shift64Diecast@gmail.com',
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #d4af37;">☀️ Shift64Diecast Morning Digest</h2>
      <p>Good morning Eric! Here's your daily diecast briefing.</p>
      <h3>📊 Dashboard</h3>
      <p><a href="https://brightsidelending.github.io/shift64diecast-os/" style="background:#d4af37;color:#000;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Open Shift64 OS →</a></p>
      <h3>🔥 Today's Checklist</h3>
      <ul>
        <li>Check Buy Report for top opportunities</li>
        <li>Review active eBay auctions in Auction Watch</li>
        <li>Scrape vendor catalogs for new arrivals</li>
      </ul>
      <p style="color:#999;font-size:12px;">Sent by Shift64Diecast OS • ${new Date().toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'})}</p>
    </div>
  `;
  await transporter.sendMail({
    from: 'Shift64Diecast OS <Shift64Diecast@gmail.com>',
    to: ['Shift64Diecast@gmail.com', 'erictran925@gmail.com'],
    subject: `☀️ Shift64 Morning Digest — ${new Date().toLocaleDateString('en-US', {month:'short', day:'numeric'})}`,
    html
  });
  return res.status(200).json({ success: true });
}
