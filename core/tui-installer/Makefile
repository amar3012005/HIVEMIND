BIN      := hivemind-mcp
PKG      := github.com/hivemind/tui-installer/cmd/hivemind-mcp
DIST     := dist
VERSION  ?= 0.1.0
ENDPOINT ?= https://core.hivemind.davinciai.eu:8050/api/mcp

LDFLAGS := -s -w \
	-X main.version=$(VERSION) \
	-X main.defaultEndpoint=$(ENDPOINT)

.PHONY: deps build run release clean

deps:
	go mod tidy

build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN) $(PKG)

run: build
	./$(BIN)

release: clean
	mkdir -p $(DIST)
	GOOS=darwin  GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BIN)-darwin-arm64  $(PKG)
	GOOS=darwin  GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BIN)-darwin-amd64  $(PKG)
	GOOS=linux   GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BIN)-linux-amd64   $(PKG)
	GOOS=linux   GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BIN)-linux-arm64   $(PKG)
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BIN)-windows-amd64.exe $(PKG)

clean:
	rm -rf $(DIST) $(BIN)
