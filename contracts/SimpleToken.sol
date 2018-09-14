pragma solidity ^0.4.24;


import "./token/ERC20/ERC20.sol";


/**
 * @title SimpleToken
 * @dev Very simple ERC20 Token example, where all tokens are pre-assigned to the creator.
 * Note they can later distribute these tokens as they wish using `transfer` and other
 * `ERC20` functions.
 */
contract SimpleToken is ERC20 {

  string public constant name = "SimpleToken";
  string public constant symbol = "SIM";
  uint8 public constant decimals = 18;

  function claim() external {
    _mint(msg.sender, 1 ether);
  }

}
