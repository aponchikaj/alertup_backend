import express from 'express'
const router = express.Router()

import USERS from '../../models/user.model'
import VERIFICATIONS from '../../models/verificatios.model'
import whoami from '../../middlewares/whoami'
import sendMail from '../../services/sendEmail'

router.post('/api/verify/send', whoami, async (req, res) => {
    try {
        const USER = await USERS.findById(req.user._id)
        if (!USER) {
            return res.send({ Success: false, Message: 'User not found.' })
        }

        if (USER.verified) {
            return res.send({ Success: false, Message: 'Account already verified.' })
        }

        // Remove existing verification
        await VERIFICATIONS.deleteOne({ verificationBy: USER._id })

        const CODE = Math.floor(100000 + Math.random() * 900000)

        await sendMail(
            USER.email,
            'Verify account - Alertup',
            `Hello ${USER.username}, your verification code is: ${CODE}`
        )

        await VERIFICATIONS.create({
            verificationType: 'VERIFY',
            verificationCode: CODE,
            verificationBy: USER._id,
            expires: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
        })

        return res.send({ Success: true, Message: 'Verification code sent.' })

    } catch (err) {
        console.error(err)
        return res.send({ Success: false, Message: 'Something went wrong.' })
    }
})

router.post('/api/verify/code', whoami, async (req, res) => {
    const { userCode } = req.body

    try {
        const USER = await USERS.findById(req.user._id)
        if (!USER) {
            return res.send({ Success: false, Message: 'User not found.' })
        }

        if (USER.verified) {
            return res.send({ Success: false, Message: 'Account already verified.' })
        }

        const verification = await VERIFICATIONS.findOne({ verificationBy: USER._id })

        if (!verification) {
            return res.send({ Success: false, Message: 'No verification request found.' })
        }

        if (verification.expires < new Date()) {
            await VERIFICATIONS.deleteOne({ verificationBy: USER._id })
            return res.send({ Success: false, Message: 'Verification code expired.' })
        }

        if (verification.verificationCode !== Number(userCode)) {
            return res.send({ Success: false, Message: 'Invalid verification code.' })
        }

        await USERS.findByIdAndUpdate(USER._id, { verified: true })
        await VERIFICATIONS.deleteOne({ verificationBy: USER._id })

        return res.send({ Success: true, Message: 'Account verified successfully.' })

    } catch (err) {
        console.error(err)
        return res.send({ Success: false, Message: 'Something went wrong.' })
    }
})

export default router
