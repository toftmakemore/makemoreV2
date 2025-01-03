require('dotenv').config();
const FtpDeploy = require("ftp-deploy");
const ftpDeploy = new FtpDeploy();

const config = {
  user: process.env.FTP_USER,
  password: process.env.FTP_PASSWORD,
  host: process.env.FTP_HOST,
  port: process.env.FTP_PORT,
  localRoot: __dirname + "/dist",
  remoteRoot: "/public_html/",
  include: ["*", "**/*"],
  deleteRemote: false,
  forcePasv: true,
};

ftpDeploy
  .deploy(config)
  .then(() => console.log("Deployment afsluttet"))
  .catch((err) => console.log("Deployment fejl:", err));