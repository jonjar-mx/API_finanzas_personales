import net from 'node:net';
import tls from 'node:tls';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

function hasSmtpConfig() {
  return Boolean(config.smtp.host && config.smtp.from);
}

function encodeSubject(value) {
  return /[^\x00-\x7F]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
    : value;
}

function buildMessage({ to, subject, text }) {
  const from = config.smtp.from;
  const date = new Date().toUTCString();

  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
  ].join('\r\n');
}

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(lastLine)) {
        cleanup();
        resolve(lines.join('\n'));
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function command(socket, value, expectedCodes) {
  socket.write(`${value}\r\n`);
  const response = await readLine(socket);
  const code = response.slice(0, 3);
  if (!expectedCodes.includes(code)) {
    throw new Error(`SMTP command failed: ${value} -> ${response}`);
  }
  return response;
}

async function connectSmtp() {
  const port = config.smtp.port;
  const socket = config.smtp.secure
    ? tls.connect({ host: config.smtp.host, port, servername: config.smtp.host })
    : net.connect({ host: config.smtp.host, port });

  await new Promise((resolve, reject) => {
    socket.once(config.smtp.secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  await readLine(socket);
  return socket;
}

async function sendSmtpMail({ to, subject, text }) {
  let socket = await connectSmtp();

  try {
    await command(socket, `EHLO ${config.smtp.heloName}`, ['250']);

    if (!config.smtp.secure && config.smtp.startTls) {
      await command(socket, 'STARTTLS', ['220']);
      socket = tls.connect({ socket, servername: config.smtp.host });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      await command(socket, `EHLO ${config.smtp.heloName}`, ['250']);
    }

    if (config.smtp.user && config.smtp.password) {
      await command(socket, 'AUTH LOGIN', ['334']);
      await command(socket, Buffer.from(config.smtp.user).toString('base64'), ['334']);
      await command(socket, Buffer.from(config.smtp.password).toString('base64'), ['235']);
    }

    await command(socket, `MAIL FROM:<${config.smtp.fromAddress}>`, ['250']);
    await command(socket, `RCPT TO:<${to}>`, ['250', '251']);
    await command(socket, 'DATA', ['354']);
    socket.write(`${buildMessage({ to, subject, text })}\r\n.\r\n`);
    const dataResponse = await readLine(socket);
    if (!dataResponse.startsWith('250')) {
      throw new Error(`SMTP DATA failed: ${dataResponse}`);
    }
    await command(socket, 'QUIT', ['221']);
  } finally {
    socket.end();
  }
}

export async function queuePasswordResetEmail({ userId, email, temporaryPassword }) {
  const subject = 'Contrasena temporal - Finanzas personales';
  const text = [
    'Se solicito reiniciar la contrasena de tu cuenta de Finanzas personales.',
    '',
    `Contrasena temporal: ${temporaryPassword}`,
    '',
    'Ingresa con esta contrasena y cambiala desde Configuracion de cuenta.',
    'Si no solicitaste este cambio, entra a tu cuenta y cambia la contrasena cuanto antes.',
  ].join('\n');

  const inserted = await pool.query(
    `INSERT INTO password_reset_emails (user_id, email, subject, body, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, email, subject, text, hasSmtpConfig() ? 'pending' : 'queued']
  );
  const emailId = inserted.rows[0].id;

  if (!hasSmtpConfig()) {
    console.info(`[password-reset] SMTP not configured. Queued temporary password email ${emailId} for ${email}.`);
    return { id: emailId, status: 'queued' };
  }

  try {
    await sendSmtpMail({ to: email, subject, text });
    await pool.query(
      `UPDATE password_reset_emails
       SET status = 'sent', sent_at = now(), updated_at = now()
       WHERE id = $1`,
      [emailId]
    );
    return { id: emailId, status: 'sent' };
  } catch (error) {
    await pool.query(
      `UPDATE password_reset_emails
       SET status = 'failed', error = $2, updated_at = now()
       WHERE id = $1`,
      [emailId, error.message]
    );
    console.error(`[password-reset] Failed to send temporary password email ${emailId} to ${email}:`, error);
    return { id: emailId, status: 'failed' };
  }
}
