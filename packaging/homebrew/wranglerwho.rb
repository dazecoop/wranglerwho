# Canonical source for the Homebrew formula.
# On a `v*` tag, .github/workflows/release.yml sets the version + sha256 here and
# commits the result to the tap repo (dazecoop/homebrew-tap) as Formula/wranglerwho.rb.
# To refresh the sha256 by hand:  npm pack && shasum -a 256 wranglerwho-*.tgz
class Wranglerwho < Formula
  desc "Switch between multiple Cloudflare / wrangler accounts"
  homepage "https://github.com/dazecoop/wranglerwho"
  url "https://registry.npmjs.org/wranglerwho/-/wranglerwho-0.1.0.tgz"
  sha256 "e9a1fd6d74d1d41db9351751d9767477eb66ce07f11540a3c637bf906bf7bee3"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "wranglerwho", shell_output("#{bin}/wranglerwho help")
  end
end
