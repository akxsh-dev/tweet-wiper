# Tweet Wiper

Delete all your tweets, replies and reposts on X (Twitter) for free. It's one small script that runs in your own browser.

- **Free and open source.** No subscription, no app, no "connect your account" page.
- **Private.** It runs in your logged-in x.com tab and only talks to x.com, the same way the X website does. Nothing is sent anywhere else, and it never asks for your password.
- **Hands-off.** Press Delete once and it works through thousands of tweets by itself, pausing on its own to stay under X's limits.

## What it deletes

| Deletes | Leaves alone |
| --- | --- |
| Your posts (tweets, threads, quote posts) | Likes |
| Your replies | Bookmarks |
| Your reposts (it undoes them) | Direct messages |
| | Followers and following |

Filters let you keep some tweets:

- only delete tweets older or newer than a date
- keep tweets with at least N likes
- keep tweets that contain certain words
- keep specific tweets (paste their links)

## How to use it

You need a desktop browser: Chrome, Edge, Brave, Firefox or another Chromium browser.

1. Open [x.com](https://x.com) and log in to the account you want to clean.
2. Open the browser console: press **F12** and click the **Console** tab. The shortcut is **Ctrl+Shift+J** on Windows and Linux, or **Cmd+Option+J** on a Mac.
3. The first time you paste into the console, Chrome blocks it as a safety measure. Type `allow pasting` and press **Enter**.
4. Open [`tweet-wiper.js`](tweet-wiper.js), click **Raw**, then press **Ctrl+A** and **Ctrl+C** to copy all of it.
5. Paste it into the console and press **Enter**. The Tweet Wiper panel appears in the top right corner.
6. Press **Scan my profile**. It lists your posts, replies and reposts straight from X.
7. Optional: set filters, press **Preview** to see what will go, or press **Download list (CSV)** to keep a spreadsheet of it.
8. Press **Delete** and confirm.

That's it. Leave the tab open. When a batch is done, it rescans your profile and keeps going until nothing that matches your filters is left.

## How long it takes

X allows about 200 deletes per 15 minutes per account. Tweet Wiper slows down before it reaches that cap, so it does about 800 an hour, or around 19,000 a day.

| Tweets | Time |
| --- | --- |
| 1,000 | about 1.5 hours |
| 5,000 | about 7 hours |
| 20,000 | about a day |

While it runs:

- Keep the x.com tab open. It keeps working while the tab is in the background or you use other tabs.
- Keep the computer awake. Plug it in and turn off sleep, because deleting stops while the computer sleeps.
- "Near X's limit... Resting" in the panel is normal. It continues by itself when the countdown ends.

## Stopping and resuming

Press **Stop** at any time. The panel remembers in your browser which tweets it already deleted. To carry on later, paste the script again, press **Scan my profile**, then **Delete**. Finished tweets are skipped.

## Tweets older than X will show (archive file)

X doesn't always list every old tweet on your profile. To catch everything:

1. On X go to **Settings and privacy → Your account → Download an archive of your data**. It can take up to a day to arrive.
2. Unzip it.
3. In the panel press **Load archive file** and pick `data/tweets.js`. Large accounts also have `tweets-part1.js`, `tweets-part2.js` and so on; select them all.

The archive is also your backup. Keep it, because deleting can't be undone.

## Is it safe?

- **Read the code first.** Only paste code you trust into a browser console. Tweet Wiper is a single readable file with no outside scripts, no tracking and no requests to anything other than x.com.
- **Never share** your browser cookies or what your console shows with anyone, including people offering to "help".
- **Deleting is permanent.** X has no undo. Download your archive first if you might want your tweets later.
- **X's rules.** X's terms discourage automated actions. Tweet Wiper deletes at the pace X itself allows and backs off before hitting the limit, which is what keeps accounts from being flagged, but use it at your own risk. If X asks you to confirm "unusual activity", complete the check on x.com and press Delete again.

## Troubleshooting

| You see | What to do |
| --- | --- |
| No panel after pasting | Wait until x.com has fully loaded, reload the page and paste again. |
| "Can't tell which account is logged in" | Log in to x.com and wait for the home page to load. |
| "X turned down the request" | It looks up X's latest internal ids by itself. If that fails, it switches to clicking through X's own menus, which is slower but works the same. |
| "X says you're logged out" | Log in again, paste the script and press Delete. Finished tweets are remembered. |
| "15 failures in a row, so it paused" | Check that x.com works in another tab, then press Resume. |
| Profile count doesn't reach 0 | X's post count lags behind and sometimes counts deleted tweets. Check the Posts, Replies and Reposts tabs instead. |

## Tweaks

Before pasting the script you can change its pacing. For example:

```js
window.tweetWiperConfig = { minDelayMs: 3000, maxDelayMs: 6000 }
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `minDelayMs`, `maxDelayMs` | 1500, 3500 | Random pause between deletes |
| `stopAtRemaining` | 5 | Rest once X reports this few deletes left in its window |
| `batchSize`, `batchRestMin` | 180, 16 | When X sends no limit info, rest this many minutes after this many deletes |
| `timeoutMs` | 20000 | Give up on a request after this long |

Only these number settings are read. Anything else in `tweetWiperConfig` is ignored.

## How it works

- **Listing:** X's website loads each profile tab (Posts, Replies, Reposts) with its own internal requests. Tweet Wiper notes those requests as the page makes them and sends them again page by page, so it always gets a fresh list from X instead of what the page has cached.
- **Deleting:** posts and replies are deleted with the same `DeleteTweet` request the X website sends when you click Delete. Reposts are undone with `DeleteRetweet`.
- **Pacing:** it reads X's rate-limit headers and rests until the window resets, with a random pause between requests.
- **Fallbacks:** if X renames its internal requests, it finds the new names in the scripts x.com itself loaded. If that fails too, it opens each tweet and clicks through X's own menus.

## Disclaimer

Tweet Wiper is not affiliated with or endorsed by X Corp. It's provided as is, without warranty. You're responsible for how you use it on your own account.

## License

[MIT](LICENSE)
