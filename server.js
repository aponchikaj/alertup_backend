import cors from 'cors'
import express from 'express'
import bparser from 'body-parser'
import cparser from 'cookie-parser'
import mongoose from 'mongoose'
import 'dotenv/config'

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cparser())
app.use(cors())
app.use(bparser.json())



mongoose.connect(process.env.MONGO_STRING).then(()=>{
    app.listen(PORT,()=>console.log("Server is Running."))
}).catch((e)=>{
    console.error('Error: ' + e)
})