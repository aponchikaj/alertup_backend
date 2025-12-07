import nodemailer from 'nodemailer';
import 'dotenv/config'

const transport = nodemailer.createTransport({
    service:"gmail",
    auth:{
        user:process.env.GMAIL_USER,
        pass:process.env.GMAIL_PASS
    }
})

const sendMail = async(to,subject,text)=>{
    if(!to||!subject||!text){
        return false
    }

    await transport.sendMail({
        from:process.env.GMAIL_USER,
        to,
        subject,
        text
    })
}

export default sendMail