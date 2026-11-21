# Getting Gloryhole live: a simple checklist

For Wookey Films · Updated November 11, 2026

The recommended setup is:

**Someone uploads through your website → files wait in a private cloud inbox → your Mac collects them → files land in your chosen folder.**

The sender needs no account. Your Mac can be offline during the upload and collect the files later.

**Important:** this is the plan for the next version. The current Gloryhole prototype does not yet upload to cloud storage or encrypt files end-to-end. Some steps below are account setup you can do yourself; the steps marked **Build work** require changes to Gloryhole.

## The services I suggest

| What you need | Suggested service | What it does |
| --- | --- | --- |
| Somewhere to run the website | [Render](https://render.com/docs/your-first-deploy) | Keeps the upload portal and its coordinating software online |
| A record of links, transfers, and reports | [Render Postgres](https://render.com/docs/postgresql-creating-connecting) | Stores the service’s records; the large video files go elsewhere |
| Temporary storage for uploaded files | [Cloudflare R2](https://developers.cloudflare.com/r2/get-started/) | Holds files until your Mac collects them |
| A place to keep the application code | [GitHub](https://github.com/) | Lets Render deploy the prepared application from a private repository |
| Your website address | Your existing domain provider | Connects an address such as files.wookeyfilms.com to the upload portal |

This is my suggested combination, rather than a requirement to use those particular companies. [Backblaze B2](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api) is another storage option if you prefer it. Start with one provider rather than setting up both.

## 1. Decide on a few defaults — You

Write down:

- Which Mac will collect the files.
- Which local folder or mounted network drive it will use.
- The largest file you expect people to send.
- How long uncollected files should stay in the cloud.
- Whether end-to-end encryption is required before the first real upload.

For Wookey’s production footage, my recommendation is to include end-to-end encryption before sending confidential material.

**Finished when:** these decisions are written down. You do not need to buy new hardware yet.

## 2. Set up the accounts — You

Create or use existing Wookey-owned accounts for:

1. GitHub.
2. Render.
3. Cloudflare.

Find out who controls the domain settings for wookeyfilms.com. That might be your website provider, domain registrar, or the person who set up the site.

Use company-controlled accounts so the service remains accessible if a staff member changes.

**Finished when:** you can sign into the three accounts and know who can add a website address. You can defer paid hosting until the new application is ready for testing.

## 3. Prepare the hosted version of Gloryhole — Build work

This is the main development step. Creating the accounts alone will not connect them to the current prototype.

The next version needs to:

- Send files from the browser directly to the private cloud inbox.
- Resume interrupted uploads.
- Track links and transfers in the database.
- Let the Mac check for incoming files and download them automatically.
- Produce reports for uploads, failures, and confirmed delivery.
- Provide Wookey-only access for managing links and receiving devices.
- Encrypt files in the sender’s browser and decrypt them on the Mac, if encryption is part of the launch.

The prepared code goes in a private GitHub repository. Actual footage, local reports, and passwords stay out of that repository.

**Finished when:** there is a working test version and a short list of the settings needed to connect the services.

## 4. Create the cloud inbox — You, with the prepared application

In Cloudflare:

1. Open **R2**.
2. Enable R2 if the account asks you to.
3. Create a bucket — a storage container — named something like **wookey-gloryhole-inbox**.
4. Keep it private; leave public access off.
5. Create an access token limited to this bucket, following the developer’s setup instructions.
6. Put the credentials in Render’s private settings when instructed. Keep them out of browser code and GitHub.

The developer will configure the permissions that let the upload page send files, temporary upload permissions, and cleanup of expired files. The browser should receive temporary permission for a specific upload, rather than the account’s main storage credentials. [R2 setup](https://developers.cloudflare.com/r2/get-started/), [temporary upload links](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

**Finished when:** the test application can upload and retrieve a test file from the private bucket.

### What “encrypted cloud storage” means here

R2 automatically encrypts stored data using keys managed by Cloudflare. That protects storage but does not, by itself, prevent the provider from reading the content. [R2 encryption details](https://developers.cloudflare.com/r2/reference/data-security/).

For end-to-end encryption, Gloryhole must encrypt the file **before it reaches R2**. The Mac keeps the private decryption key. R2 then stores an unreadable encrypted copy. The key setup, recovery procedure, and encryption implementation are part of step 3, not a checkbox in the storage account.

## 5. Put the prepared application online — You + Build work

In Render:

1. Connect your GitHub account.
2. Choose **New → Postgres** to create the application’s database.
3. Choose **New → Web Service** and select the prepared Gloryhole repository.
4. Put the web service and database in the same region.
5. Enter the build/start instructions supplied with that version.
6. Add the database and R2 connection settings in Render’s private settings.
7. Deploy and open the temporary Render address.

Use paid service and database instances for real use. Render describes its free instances as unsuitable for production. [First deployment](https://render.com/docs/your-first-deploy), [database setup](https://render.com/docs/postgresql-creating-connecting), [free-instance limitations](https://render.com/docs/free).

**Finished when:** the website loads and can create a test request without your Mac hosting the page.

## 6. Give it your Wookey address — You or your website administrator

Use **files.wookeyfilms.com**, if you like that address.

1. In Render, open the service’s **Settings → Custom Domains**.
2. Add **files.wookeyfilms.com**.
3. Send the DNS record Render supplies to whoever controls your domain.
4. Ask them to add that record for the **files** subdomain.
5. Return to Render and verify the address.

Your main Wookey website and email can stay where they are. Render provides and renews the HTTPS certificate. [Custom-domain instructions](https://render.com/docs/custom-domains).

**Finished when:** the upload portal opens at the Wookey address over HTTPS.

## 7. Set up the receiving Mac — You + Build work

Install the new receiver version prepared in step 3.

1. Connect the Mac using Ethernet where possible.
2. Open the receiver and connect it to your Wookey account.
3. Choose the destination folder.
4. If it is a network drive, connect that drive in Finder first.
5. Allow the receiver to start when you sign in.
6. Follow the supplied instructions to back up its encryption recovery key securely.

This receiver will connect outward to the hosted service. You will no longer need to keep the prototype’s temporary tunnel running.

**Finished when:** a cloud upload arrives in the selected folder, its integrity is verified, and the receiver report confirms delivery.

## 8. Run a small test before inviting clients — You

Use test files first:

1. Send a small file from another computer.
2. Send a typical large production file.
3. Interrupt a transfer, then check that it resumes.
4. Turn the receiving Mac off, upload, then turn the Mac back on.
5. Disconnect the network drive and check the error/report behavior.
6. Confirm the downloaded files and both sides’ reports.
7. Confirm expired or closed links stop accepting uploads.

If using end-to-end encryption, the developer should also verify that the stored cloud object is ciphertext and that only the correct receiver can decrypt it. Arrange an independent security review before relying on an end-to-end encryption claim.

**Finished when:** those tests pass and any failed test is fixed.

## 9. Launch with a small group — You

Start with a few trusted collaborators.

Check their real file sizes, upload times, report accuracy, and whether files consistently arrive on the Mac. Confirm cloud retention and deletion settings match what you promised senders.

Review the hosting and storage bills after the first month before expanding.

## Keeping it fast

Ask the developer to make uploads go directly to R2, rather than passing all footage through the website server. R2 supports direct uploads using temporary upload permissions. [Direct-upload guidance](https://developers.cloudflare.com/r2/objects/upload-objects/).

The other priorities are resumable uploads, a few upload parts running in parallel, wired Ethernet, and a fast destination drive. Measure real production files; a faster hosting plan cannot fix a slow sender connection.

## What you can do first

**Start with steps 1 and 2. Then the next substantial task is step 3: building the hosted version.** The rest becomes account configuration, installation, and testing once that version exists.

For the deeper architecture and encryption discussion, see [the technical plan](GOING-LIVE-TECHNICAL.md).
